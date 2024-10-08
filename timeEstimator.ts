import Replicate from "replicate";

const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
});

const response = await replicate.predictions.list();

response.results.forEach(result => {
    console.log(result.metrics);
});

const totalTimes = [];

for (const prediction of response.results) {
    if (prediction.status === "succeeded" && prediction.metrics) {
        const metrics = prediction.metrics || {};
        const totalTime = Object.values(metrics).reduce((sum, value) => sum + (parseFloat(value.toString()) || 0), 0);
        totalTimes.push(totalTime);
    }
}

if (totalTimes.length > 0) {
    totalTimes.sort((a, b) => a - b);
    const medianIndex = Math.floor(totalTimes.length / 2);
    const medianTotalTime = totalTimes.length % 2 === 0
        ? (totalTimes[medianIndex - 1] + totalTimes[medianIndex]) / 2
        : totalTimes[medianIndex];

    console.log(`Median total time: ${medianTotalTime.toFixed(2)} seconds`);
} else {
    console.log("No successful predictions found");
}