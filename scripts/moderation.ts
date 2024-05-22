import OpenAI from "openai";
const { google } = require('googleapis');

const DISCOVERY_URL = 'https://commentanalyzer.googleapis.com/$discovery/rest?version=v1alpha1';
const openai = new OpenAI();

const input = "I hate you! You are a bad person!";


const checkScore = async (text: string, language: string) => {
    const analyzeRequest = {
        comment: { text },
        languages: [language],
        requestedAttributes: {
            TOXICITY: {},
            SEVERE_TOXICITY: {},
            INSULT: {},
            PROFANITY: {},
            THREAT: {},
            SEXUALLY_EXPLICIT: {}
        }
    };

    return google.discoverAPI(DISCOVERY_URL)
        .then((client: {
            comments:
            {
                analyze: (arg0: {
                    key: string | undefined; resource:
                    {
                        comment:
                        { text: string; };
                        languages: string[];
                        requestedAttributes:
                        {
                            TOXICITY: {};
                            SEVERE_TOXICITY: {};
                            INSULT: {};
                            PROFANITY: {};
                            THREAT: {};
                            SEXUALLY_EXPLICIT: {};
                        };
                    };
                }, arg1: (err: any, response: any) => void) => void;
            };
        }) => {
            return new Promise((resolve, reject) => {
                client.comments.analyze({
                    key: process.env.PERSPECTIVE_API_KEY,
                    resource: analyzeRequest
                }, (err: any, response: { data: unknown; }) => {
                    if (err) reject(err);
                    else resolve(response.data);
                });
            });
        })
        .then((responseData: { attributeScores: { [x: string]: { summaryScore: { value: any; }; }; }; }) => {
            let isToxic = false;
            const expectedAttributes = [
                'TOXICITY', 'SEVERE_TOXICITY', 'INSULT', 'PROFANITY', 'THREAT', 'SEXUALLY_EXPLICIT'
            ];

            for (const attribute of expectedAttributes) {
                const summaryScore = responseData.attributeScores[attribute]?.summaryScore?.value;
                if (summaryScore > 0.5) {
                    isToxic = true;
                    break;
                }
            }
            return isToxic;
        });
};
console.log("input ->", input);
async function main() {
    const moderation = await openai.moderations.create({ input: input });

    console.log("openai", input, "is bad? ->", moderation.results[0].flagged);
}
console.log("google", input, "is bad? ->", await checkScore(input, "en"));
main();