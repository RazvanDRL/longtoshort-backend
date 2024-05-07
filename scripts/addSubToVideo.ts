import { $ } from 'bun';
import { convertSRT } from './convertSRT';

async function addSubToVideo(videoURL: string, user_id: string, video_id: string) {
    let videoPath = `${user_id}/${video_id}.mp4`;
    let subtitlePath = `${user_id}/${video_id}.srt`;
    await convertSRT(user_id, video_id);
    await $`time ffmpeg -i ${videoPath} -vf "subtitles=${subtitlePath}:force_style='FontName=The Bold Font'" ${user_id}/${video_id}_output.mp4`;
}

export { addSubToVideo };