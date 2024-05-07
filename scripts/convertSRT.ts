const fs = require('fs').promises;

import { censor } from "./censor";

async function convertSRT(user_id: string, video_id: string) {
    try {
        const filename = `${user_id}/${video_id}.json`;
        const data = await fs.readFile(filename, 'utf8');

        const subtitleData = JSON.parse(data);

        let i: number = 1;
        let srtData: string = '';

        for (const subtitle of subtitleData) {
            for (const wordObj of subtitle.words) {
                const startTime = isNaN(wordObj.start) ? 0 : wordObj.start;
                const endTime = isNaN(wordObj.end) ? 0 : wordObj.end;
                const word = await censor(wordObj.word);
                srtData += `${i}\n${formatTime(startTime)} --> ${formatTime(endTime)}\n${word}\n\n`;
                i++;
            }
        }

        await fs.writeFile(`${user_id}/${video_id}.srt`, srtData);
    } catch (error) {
        console.error('Error occurred while parsing the JSON:', error);
    }
}

// Function to format time in SRT format (hh:mm:ss,mmm)
function formatTime(timeInSeconds: number) {
    const hours = Math.floor(timeInSeconds / 3600);
    const minutes = Math.floor((timeInSeconds % 3600) / 60);
    const seconds = Math.floor(timeInSeconds % 60);
    const milliseconds = Math.round((timeInSeconds - Math.floor(timeInSeconds)) * 1000);

    return `${padZeroes(hours)}:${padZeroes(minutes)}:${padZeroes(seconds)},${padZeroes(milliseconds, 3)}`;
}

// Function to pad zeroes for formatting time
function padZeroes(number: number, width = 2) {
    return String(number).padStart(width, '0');
}

export { convertSRT };