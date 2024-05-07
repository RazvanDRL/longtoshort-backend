import Replicate, { Prediction } from "replicate";
import { $ } from "bun";

import { supabase } from "./scripts/supabaseClient";

const version = "3cafb09bd68dc82d1c09f7f91d5f67451d61242b8acf83e9ad4e27422dc51b28";

const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
});

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

async function fetchVideo(path: string) {
    try {
        const response = await fetch(`http://localhost:3000/api/generate-signed-url?key=${path}?bucket=upload-bucket`, {
            method: 'POST'
        });

        if (!response.ok) {
            throw new Error('Failed to fetch signed URL');
        }

        const data = await response.json() as { url: string };

        return data.url;
    } catch (error) {
        console.error('Error fetching video:', error);
    }
}

async function processQueueItem(row: queueItem) {
    const path = `${row.user_id}/${row.video_id}.mp4`;

    const url = await fetchVideo(path);

    if (url) {
        const controller = new AbortController();
        let cancelled = false;

        const timer = setTimeout(async () => {
            if (!cancelled) {
                await abortPrediction(controller);
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
                            .match({ id: row.id });
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
                            .match({ id: row.id });
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
                            .match({ id: row.id });
                        if (update_prediction_id_error) {
                            console.log(update_prediction_id_error);
                        }
                        else {
                            preditctionID = progress.id;
                        }
                    }
                }
            );
            await $`mkdir -p ${row.user_id}`;
            await $`curl -o ${path} ${url}`;
            let fps_cmd = await $`ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 ${path}`;
            // fps_cmd will be in the form of "2997/100" and i want to add to the database only the number 29.97
            let fps = parseFloat(fps_cmd.stdout.toString().split("/")[0]) / parseFloat(fps_cmd.stdout.toString().split("/")[1]);

            const { data, error } = await supabase
                .from('metadata')
                .update({ fps: fps })
                .match({ id: row.video_id });

            if (output) {
                await supabase
                    .from("processing_queue")
                    .update([
                        { status: "succeeded" },
                    ])
                    .match({ id: row.id });
                const { data, error } = await supabase
                    .from('subs')
                    .insert([
                        { id: row.video_id, user_id: row.user_id, subtitles: output },
                    ])
                    .select()
            }
            await $`rm -rf ${row.user_id}`;
        } catch (error) {
            console.log(error);
        } finally {
            clearTimeout(timer);
            await supabase
                .from("metadata")
                .update([{ processed: true }])
                .match({ id: row.video_id });

            await supabase
                .from("processing_queue")
                .update([
                    { status: "done" },
                ])
                .match({ id: row.id });

            await new Promise(resolve => setTimeout(resolve, 2000));

            const { error: delete_error } = await supabase
                .from("processing_queue")
                .delete()
                .match({ id: row.id });

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
