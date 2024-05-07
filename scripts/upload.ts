import { file } from 'bun';
import { supabase } from './supabaseClient';


async function upload(user_id: string, video_id: string) {
    let subtitleFile = file(`${user_id}/${video_id}.srt`);
    let outputFile = file(`${user_id}/${video_id}_output.mp4`);

    const { data: subtitleData, error: subtitleError } = await supabase
        .storage
        .from('processed_videos')
        .upload(`${user_id}/${video_id}.srt`, subtitleFile, {
            cacheControl: '3600',
            upsert: false
        })
    if (subtitleError) {
        console.log(subtitleError);
    }

    const { data: videoData, error: videoError } = await supabase
        .storage
        .from('processed_videos')
        .upload(`${user_id}/${video_id}.mp4`, outputFile, {
            cacheControl: '3600',
            upsert: false
        })

    if (videoError) {
        console.log(videoError);
    }


    // const { data, error } = await supabase
    //     .storage
    //     .from('videos')
    //     .remove([`${user_id}/${video_id}.mp4`]);

    // if (error) {
    //     console.log(error);
    // }
}

export { upload };