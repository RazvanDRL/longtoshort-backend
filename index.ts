import Replicate, { Prediction } from "replicate";
import S3 from 'aws-sdk/clients/s3.js';
import { $ } from "bun";
import { supabase } from "./scripts/supabaseClient";
import sendMessage from "./scripts/sendMessage";

require("aws-sdk/lib/maintenance_mode_message").suppress = true;

const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
});

const s3 = new S3({
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID!}.r2.cloudflarestorage.com`,
    accessKeyId: process.env.CLOUDFLARE_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.CLOUDFLARE_AWS_SECRET_ACCESS_KEY!,
    signatureVersion: 'v4',
});

const REPLICATE_MODEL_VERSION = "2774059f636228942fcd4b8caf5b1ef79f4671f742d65728f7c7538f8a5aedc8";
const ABORT_TIMEOUT = 600000; // 10 minutes

type QueueItem = {
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
let predictionID: string | null = null;

async function fetchVideo(user_id: string, video_id: string): Promise<string | undefined> {
    try {
        return await s3.getSignedUrlPromise('getObject', {
            Bucket: "upload-bucket",
            Key: `${user_id}/${video_id}.mp4`,
            Expires: 3600
        });
    } catch (error) {
        console.error('Error fetching video:', error);
        sendMessage(`Error fetching video: ${error}`);
        return undefined;
    }
}

async function uploadVideo(user_id: string, video_id: string): Promise<void> {
    try {
        console.log('Compressing video');
        await $`ffmpeg -i ${user_id}/${video_id}.mp4 -vf "scale=iw/2:ih/2" ${user_id}/${video_id}-compressed.mp4`;
        console.log('Uploading video');
        const file = Bun.file(`${user_id}/${video_id}-compressed.mp4`);

        if (!await file.exists()) {
            console.log('File does not exist');
            sendMessage(`File does not exist: ${user_id}/${video_id}-compressed.mp4`);
            return;
        }

        const response = await fetch(`${process.env.SITE_URL}/api/upload?key=${user_id}/${video_id}-compressed.mp4`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'video/mp4',
            },
            body: file,
        });

        if (!response.ok) {
            throw new Error(`Failed to upload video: ${response.statusText}`);
        }
        console.log('Video uploaded');
    } catch (error) {
        console.error('Error uploading video:', error);
        sendMessage(`Error uploading video: ${error}`);
    }
}

async function updateSupabase(table: string, data: object, id: string): Promise<void> {
    const { error } = await supabase
        .from(table)
        .update(data)
        .match({ id });

    if (error) {
        console.error(`Error updating ${table}:`, error);
        sendMessage(`Error updating ${table}: ${error}`);
    }
}

async function processQueueItem(row: QueueItem): Promise<void> {
    const { id, user_id, video_id } = row;
    const { data: credits, error: credits_error } = await supabase
        .from("profiles")
        .select("credits")
        .eq("id", user_id)
        .single();

    if (credits_error) {
        console.error('Error fetching credits:', credits_error);
        sendMessage(`Error fetching credits: ${credits_error}`);
        return;
    }

    if (credits && credits.credits > 0) {
        await updateSupabase("profiles", { credits: credits.credits - 1 }, user_id);
        const url = await fetchVideo(user_id, video_id);
        if (url) {
            const controller = new AbortController();
            let cancelled = false;

            const timer = setTimeout(async () => {
                if (!cancelled) {
                    await abortPrediction(controller);
                    await updateSupabase("processing_queue", { status: "aborted" }, id);
                }
            }, ABORT_TIMEOUT);

            try {
                await $`mkdir -p ${user_id}`;
                await $`curl -o ${user_id}/${video_id}.mp4 ${url}`;
                const uploadPromise = uploadVideo(user_id, video_id);

                const replicatePromise = await replicate.run(
                    `razvandrl/subtitler:${REPLICATE_MODEL_VERSION}`,
                    {
                        input: {
                            file: url,
                            batch_size: 32,
                        },
                        signal: controller.signal,
                    },
                    async (progress: Prediction) => {
                        await handleProgress(progress, id, cancelled, controller, timer as NodeJS.Timeout);
                    }
                );

                await updateVideoMetadata(user_id, video_id);
                const [output] = await Promise.all([replicatePromise, uploadPromise]);

                if (output) {
                    await updateSupabase("processing_queue", { status: "loading" }, id);
                    await supabase
                        .from('subs')
                        .insert([
                            { id: video_id, user_id: user_id, subtitles: output },
                        ])
                        .select();
                }
            } catch (error) {
                console.error('Error processing queue item:', error);
                sendMessage(`Error processing queue item: ${error}`);
            } finally {
                await cleanupProcessing(id, video_id, user_id);
            }
        }
    } else {
        await handleInsufficientCredits(id);
    }
}

async function handleProgress(progress: Prediction, id: string, cancelled: boolean, controller: AbortController, timer: NodeJS.Timeout): Promise<void> {
    const cost = progress.metrics?.predict_time ? progress.metrics.predict_time * 0.000225 : 0;
    console.log(progress.status, 'predict_time', progress.metrics?.predict_time, "$" + cost);

    if (cancelled) {
        await abortPrediction(controller);
        clearTimeout(timer);
        return;
    }

    if (lastKnownStatus !== progress.status) {
        await updateSupabase("processing_queue", { status: progress.status }, id);
        lastKnownStatus = progress.status;
    }

    if (lastKnownLogs !== progress.logs) {
        await updateSupabase("processing_queue", { logs: progress.logs ?? null }, id);
        lastKnownLogs = progress.logs ?? null;
    }

    if (predictionID !== progress.id) {
        await updateSupabase("processing_queue", { prediction_id: progress.id }, id);
        predictionID = progress.id;
    }
}

async function updateVideoMetadata(user_id: string, video_id: string): Promise<void> {
    try {
        const fps_cmd = await $`ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate -of default=noprint_wrappers=1:nokey=1 ${user_id}/${video_id}.mp4`;
        const [numerator, denominator] = fps_cmd.stdout.toString().trim().split('/');
        const fps = parseFloat(numerator) / parseFloat(denominator);

        await updateSupabase('metadata', { fps }, video_id);
    } catch (error) {
        console.error('Error updating video metadata:', error);
        sendMessage(`Error updating video metadata: ${error}`);
    }
}

async function cleanupProcessing(id: string, video_id: string, user_id: string): Promise<void> {
    try {
        await updateSupabase("metadata", { processed: true }, video_id);
        await updateSupabase("processing_queue", { status: "done" }, id);
        await new Promise(resolve => setTimeout(resolve, 2000));
        await supabase.from("processing_queue").delete().match({ id });
        await $`rm -rf ${user_id}`;
    } catch (error) {
        console.error('Error during cleanup:', error);
        sendMessage(`Error during cleanup: ${error}`);
    }
}

async function handleInsufficientCredits(id: string): Promise<void> {
    try {
        await updateSupabase("processing_queue", { status: "no_credits" }, id);
        await new Promise(resolve => setTimeout(resolve, 2000));
        await supabase.from("processing_queue").delete().match({ id });
    } catch (error) {
        console.error('Error handling insufficient credits:', error);
        sendMessage(`Error handling insufficient credits: ${error}`);
    }
}

async function abortPrediction(controller: AbortController): Promise<void> {
    try {
        controller.abort();
        console.log("Prediction aborted");
    } catch (error) {
        console.error('Error aborting prediction:', error);
        sendMessage(`Error aborting prediction: ${error}`);
    }
}

async function main(): Promise<void> {
    while (true) {
        try {
            console.log("Checking for new items in the queue");
            const { data, error } = await supabase
                .from("processing_queue")
                .select('*')
                .order('created_at', { ascending: true })
                .limit(1);

            if (error) {
                console.error('Error fetching queue:', error);
                sendMessage(`Error fetching queue: ${error}`);
                continue;
            }

            if (data && data.length > 0) {
                lastKnownStatus = null;
                lastKnownLogs = null;
                predictionID = null;
                const { data: credits, error: creditsError } = await supabase
                    .from("profiles")
                    .select("credits")
                    .eq("id", data[0].user_id)
                    .single();

                if (creditsError) {
                    console.error('Error fetching credits:', creditsError);
                    sendMessage(`Error fetching credits: ${creditsError}`);
                    continue;
                }

                if (credits && credits.credits > 0) {
                    await updateSupabase("processing_queue", { status: "processing" }, data[0].id);
                    await processQueueItem(data[0]);
                } else {
                    await supabase.from("processing_queue").delete().match({ id: data[0].id });
                }
            } else {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (error) {
            console.error('Error in main loop:', error);
            sendMessage(`Error in main loop: ${error}`);
        }
    }
}

main().catch(error => {
    console.error('Unhandled error in main loop:', error);
    sendMessage(`Unhandled error in main loop: ${error}`);
});