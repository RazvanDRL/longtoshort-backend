import fs from "fs";

async function query(filename: string) {
    const data = fs.readFileSync(filename);
    const response = await fetch(
        "https://api-inference.huggingface.co/models/openai/whisper-large-v3",
        {
            headers: { Authorization: "Bearer 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" },
            method: "POST",
            body: data,
        }
    );
    const result = await response.json();
    return result;
}

const start = Date.now();

query("testfrate.mp3").then((response) => {
    console.log((Date.now() - start) / 1000, "s");
    console.log(JSON.stringify(response));
});