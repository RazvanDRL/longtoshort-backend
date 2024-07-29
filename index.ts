const Sentry = require('@sentry/node');
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

const version = "2774059f636228942fcd4b8caf5b1ef79f4671f742d65728f7c7538f8a5aedc8";

type queueItem = {
    id: string;
    user_id: string;
    video_id: string;
    video_src?: string;
    created_at: string;
    prediction_id: string;
    status: string;
    logs: string;
};

let lastKnownStatus: string | null = null;
let lastKnownLogs: string | null = null;
let preditctionID: string | null = null;

Sentry.init({
    dsn: "https://c3bd2da376e24c15f5f8275bc1accbeb@o4507060874641408.ingest.us.sentry.io/4507284793196544",
    // Performance Monitoring
    tracesSampleRate: 1.0, //  Capture 100% of the transactions

    // Set sampling rate for profiling - this is relative to tracesSampleRate
    profilesSampleRate: 1.0,
});

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

        if (await file.exists() == false) {
            console.log('File does not exist');
            return;
        }

        const response = await fetch(`${process.env.SITE_URL}/api/upload?key=${user_id}/${video_id}-compressed.mp4`, {
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
    const { data: credits, error: credits_error } = await supabase
        .from("profiles")
        .select("credits")
        .eq("id", user_id);
    if (credits_error) {
        console.log(credits_error);
        return;
    }
    if (credits && credits.length > 0 && credits[0].credits > 0) {
        await supabase
            .from("profiles")
            .update({ credits: credits[0].credits - 1 })
            .eq("id", user_id);
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
                await $`mkdir -p ${user_id}`;
                await $`curl -o ${path} ${url}`;
                const uploadPromise = uploadVideo(user_id, video_id);

                const replicatePromise = await replicate.run(
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
                        console.log(progress.status, 'predict_time', progress.metrics?.predict_time, "$" + cost);

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
                let fps_cmd = await $`ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 ${path}`;
                // fps_cmd will be in the form of "2997/100" and i want to add to the database only the number 29.97
                let fps = parseFloat(fps_cmd.stdout.toString().split("/")[0]) / parseFloat(fps_cmd.stdout.toString().split("/")[1]);

                const { data, error } = await supabase
                    .from('metadata')
                    .update({ fps: fps })
                    .match({ id: video_id });

                const [output] = await Promise.all([replicatePromise, uploadPromise]);

                if (output) {
                    await supabase
                        .from("processing_queue")
                        .update([
                            { status: "loading" },
                        ])
                        .match({ id: id });
                    const { data, error } = await supabase
                        .from('subs')
                        .insert([
                            { id: video_id, user_id: user_id, subtitles: output },
                        ])
                        .select()
                }
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
    else {
        await supabase
            .from("processing_queue")
            .update([
                { status: "no_credits" },
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
            .order('created_at', { ascending: true })
            .limit(1);

        if (error) {
            console.log(error);
        }

        if (data && data.length > 0) {
            lastKnownStatus = null;
            lastKnownLogs = null;
            preditctionID = null;
            const credits = await supabase.from("profiles").select("credits").eq("id", data[0].user_id);
            if (credits.error) {
                console.log(credits.error);
                continue;
            }
            if (credits.data && credits.data.length > 0 && credits.data[0].credits > 0) {
                await supabase
                    .from("processing_queue")
                    .update([
                        { status: "processing" },
                    ])
                    .match({ id: data[0].id });
                await processQueueItem(data[0]);
            }
            else {
                const { error: delete_error } = await supabase
                    .from("processing_queue")
                    .delete()
                    .match({ id: data[0].id });

                if (delete_error) {
                    console.log(delete_error);
                }
            }
        } else {
            // If no new items in the queue, wait for some time before checking again
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

main();