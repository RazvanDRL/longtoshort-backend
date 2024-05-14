import Replicate, { Prediction } from "replicate";
import S3 from 'aws-sdk/clients/s3.js';
require("aws-sdk/lib/maintenance_mode_message").suppress = true;
import { $ } from "bun";
import { supabase } from "./scripts/supabaseClient";

const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
});

const s3 = new S3({
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID!}.r2.cloudflarestorage.com`,
    accessKeyId: process.env.CLOUDFLARE_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.CLOUDFLARE_AWS_SECRET_ACCESS_KEY!,
    signatureVersion: 'v4',
});

const version = "3cafb09bd68dc82d1c09f7f91d5f67451d61242b8acf83e9ad4e27422dc51b28";

type queueItem = {
    id: string;
    user_id: string;
    video_id: string;
    created_at: string;
    prediction_id: string;
    status: string;
    logs: string;
};

let lastKnownStatus: string | null = null;
let lastKnownLogs: string | null = null;
let preditctionID: string | null = null;

async function fetchVideo(user_id: string, video_id: string) {
    try {
        const url = await s3.getSignedUrlPromise('getObject', { Bucket: "upload-bucket", Key: `${user_id}/${video_id}.mp4`, Expires: 3600 });
        return url;
    } catch (error) {
        console.error('Error fetching video:', error);
    }
}

async function uploadVideo(user_id: string, video_id: string) {
    try {
        console.log('Compressing video');
        await $`ffmpeg -i ${user_id}/${video_id}.mp4 -vf "scale=iw/2:ih/2" ${user_id}/${video_id}-compressed.mp4`;

        console.log('Uploading video');
        const file = Bun.file(`${user_id}/${video_id}-compressed.mp4`);

        const response = await fetch(`
        ${process.env.SITE_URL}/api/upload?key=${user_id}/${video_id}-compressed.mp4`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'video/mp4',
            },
            body: file,
        });

        if (!response.ok)
            throw new Error(`Failed to upload video: ${response.statusText}`);
        else
            console.log('Video uploaded');
    } catch (error) {
        console.error('Error uploading video:', error);
    }
}

async function processQueueItem(row: queueItem) {
    const id = row.id;
    const user_id = row.user_id;
    const video_id = row.video_id;
    const path = `${user_id}/${video_id}.mp4`;
    const url = await fetchVideo(user_id, video_id);

    if (url) {
        const controller = new AbortController();
        let cancelled = false;

        const timer = setTimeout(async () => {
            if (!cancelled) {
                await abortPrediction(controller);
                await supabase
                    .from("processing_queue")
                    .update([
                        { status: "aborted" },
                    ])
                    .match({ id: id });
            }
        }, 600000); // 10 minutes

        try {
            const output = await replicate.run(
                `razvandrl/subtitler:${version}`,
                {
                    input: {
                        file: url,
                        batch_size: 32,
                    },
                    signal: controller.signal,
                },
                async (progress: Prediction) => {
                    let cost = progress.metrics?.predict_time == undefined ? 0 : progress.metrics?.predict_time * 0.000225;
                    console.log(progress.status, 'predict_time', progress.metrics?.predict_time, "$" + cost, new Date().getTime());

                    if (cancelled) {
                        await abortPrediction(controller);
                        clearTimeout(timer);
                        return;
                    }

                    if (lastKnownStatus !== progress.status) {
                        const { data: update_status_data, error: update_status_error } = await supabase
                            .from("processing_queue")
                            .update([
                                { status: progress.status },
                            ])
                            .match({ id: id });
                        if (update_status_error) {
                            console.log(update_status_error);
                        }
                        else {
                            lastKnownStatus = progress.status;
                        }
                    }

                    if (lastKnownLogs !== progress.logs) {
                        const { data: update_logs_data, error: update_logs_error } = await supabase
                            .from("processing_queue")
                            .update([
                                { logs: progress.logs ?? null },
                            ])
                            .match({ id: id });
                        if (update_logs_error) {
                            console.log(update_logs_error);
                        }
                        else {
                            lastKnownLogs = progress.logs ?? null;
                        }
                    }

                    if (preditctionID !== progress.id) {
                        const { data: update_prediction_id_data, error: update_prediction_id_error } = await supabase
                            .from("processing_queue")
                            .update([
                                { prediction_id: progress.id },
                            ])
                            .match({ id: id });
                        if (update_prediction_id_error) {
                            console.log(update_prediction_id_error);
                        }
                        else {
                            preditctionID = progress.id;
                        }
                    }
                }
            );
            await $`mkdir -p ${user_id}`;
            await $`curl -o ${path} ${url}`;
            let fps_cmd = await $`ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 ${path}`;
            // fps_cmd will be in the form of "2997/100" and i want to add to the database only the number 29.97
            let fps = parseFloat(fps_cmd.stdout.toString().split("/")[0]) / parseFloat(fps_cmd.stdout.toString().split("/")[1]);

            const { data, error } = await supabase
                .from('metadata')
                .update({ fps: fps })
                .match({ id: video_id });

            if (output) {
                await supabase
                    .from("processing_queue")
                    .update([
                        { status: "succeeded" },
                    ])
                    .match({ id: id });
                const { data, error } = await supabase
                    .from('subs')
                    .insert([
                        { id: video_id, user_id: user_id, subtitles: output },
                    ])
                    .select()
            }

            await uploadVideo(user_id, video_id);
            await $`rm -rf ${user_id}`;
        } catch (error) {
            console.log(error);
        } finally {
            clearTimeout(timer);
            await supabase
                .from("metadata")
                .update([{ processed: true }])
                .match({ id: video_id });

            await supabase
                .from("processing_queue")
                .update([
                    { status: "done" },
                ])
                .match({ id: id });

            await new Promise(resolve => setTimeout(resolve, 2000));

            const { error: delete_error } = await supabase
                .from("processing_queue")
                .delete()
                .match({ id: id });

            if (delete_error) {
                console.log(delete_error);
            }
        }
    }
}

async function abortPrediction(controller: AbortController) {
    controller.abort();
    console.log("Prediction aborted");
}

async function main() {
    while (true) {
        console.log("Checking for new items in the queue");
        const { data, error } = await supabase
            .from("processing_queue")
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1);

        if (error) {
            console.log(error);
        }

        if (data && data.length > 0) {
            lastKnownStatus = null;
            lastKnownLogs = null;
            preditctionID = null;
            const controller = await processQueueItem(data[0]);
            // await abortPrediction(controller);
        } else {
            // If no new items in the queue, wait for some time before checking again
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

main();
