import { $, file } from 'bun';
import { supabase } from './supabaseClient';

async function convertVideo(videoURL: string, user_id: string, video_id: string) {
    let videoPath = `${user_id}/${video_id}.mp4`;
    let audioPath = `${user_id}/${video_id}.mp3`;

    await $`mkdir -p ${user_id}`;
    await $`curl -o ${videoPath} ${videoURL}`;
    await $`ffmpeg -i ${videoPath} -q:a 0 -map a ${audioPath}`;

    const { data: audioData, error: audioError } = await supabase
        .storage
        .from('audios')
        .upload(audioPath, file(audioPath), {
            cacheControl: '3600',
            upsert: false
        })
    if (audioError) {
        console.log(audioError);
    }

    const { data: audio_data, error: audio_error } = await supabase
        .storage
        .from('audios')
        .createSignedUrl(audioPath, 86400);

    if (audio_error) {
        console.log(audio_error);
    }

    return audio_data?.signedUrl.toString();
}

export { convertVideo };