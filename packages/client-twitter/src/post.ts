import { Tweet } from "mind-agent-twitter-client";
import fs from "fs";
import { composeContext, elizaLogger } from "@ai16z/eliza";
import { generateText } from "@ai16z/eliza";
import { embeddingZeroVector } from "@ai16z/eliza";
import { IAgentRuntime, ModelClass } from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";
import { ClientBase } from "./base.ts";
import { generateImage } from "@ai16z/eliza";

const twitterPostTemplate = `{{timeline}}

# Knowledge
{{knowledge}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{postDirections}}

{{providers}}

{{recentPosts}}

{{characterPostExamples}}

# Task: Generate a post in the voice and style of {{agentName}}, aka @{{twitterUserName}}
Write a single sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Try to write something totally different than previous posts. Do not add commentary or acknowledge this request, just write the post.
Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.`;

const MAX_TWEET_LENGTH = 280;

/**
 * Truncate text to fit within the Twitter character limit, ensuring it ends at a complete sentence.
 */
function truncateToCompleteSentence(text: string): string {
    if (text.length <= MAX_TWEET_LENGTH) {
        return text;
    }

    // Attempt to truncate at the last period within the limit
    const truncatedAtPeriod = text.slice(
        0,
        text.lastIndexOf(".", MAX_TWEET_LENGTH) + 1
    );
    if (truncatedAtPeriod.trim().length > 0) {
        return truncatedAtPeriod.trim();
    }

    // If no period is found, truncate to the nearest whitespace
    const truncatedAtSpace = text.slice(
        0,
        text.lastIndexOf(" ", MAX_TWEET_LENGTH)
    );
    if (truncatedAtSpace.trim().length > 0) {
        return truncatedAtSpace.trim() + "...";
    }

    // Fallback: Hard truncate and add ellipsis
    return text.slice(0, MAX_TWEET_LENGTH - 3).trim() + "...";
}

export class TwitterPostClient extends ClientBase {
    onReady(postImmediately: boolean = true) {
        const generateNewTweetLoop = () => {
            const minMinutes =
                parseInt(this.runtime.getSetting("POST_INTERVAL_MIN")) || 1;
            const maxMinutes =
                parseInt(this.runtime.getSetting("POST_INTERVAL_MAX")) || 2;
            const randomMinutes =
                Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
                minMinutes;
            const delay = randomMinutes * 60 * 1000;

            setTimeout(() => {
                // this.generateNewTweet();
                this.generateNewTweetWithImage();
                generateNewTweetLoop(); // Set up next iteration
            }, delay);

            elizaLogger.log(`Next tweet scheduled in ${randomMinutes} minutes`);
        };

        if (postImmediately) {
            // this.generateNewTweet();
            this.generateNewTweetWithImage();
        }
        generateNewTweetLoop();
    }

    constructor(runtime: IAgentRuntime) {
        super({
            runtime,
        });
    }

    private async generateNewTweet() {
        elizaLogger.log("Generating new tweet");
        try {
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.runtime.getSetting("TWITTER_USERNAME"),
                this.runtime.character.name,
                "twitter"
            );

            let homeTimeline = [];

            if (!fs.existsSync("tweetcache")) fs.mkdirSync("tweetcache");
            if (fs.existsSync("tweetcache/home_timeline.json")) {
                homeTimeline = JSON.parse(
                    fs.readFileSync("tweetcache/home_timeline.json", "utf-8")
                );
            } else {
                homeTimeline = await this.fetchHomeTimeline(50);
                fs.writeFileSync(
                    "tweetcache/home_timeline.json",
                    JSON.stringify(homeTimeline, null, 2)
                );
            }

            const formattedHomeTimeline =
                `# ${this.runtime.character.name}'s Home Timeline\n\n` +
                homeTimeline
                    .map((tweet) => {
                        return `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}\nText: ${tweet.text}\n---\n`;
                    })
                    .join("\n");

            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: stringToUuid("twitter_generate_room"),
                    agentId: this.runtime.agentId,
                    content: { text: "", action: "" },
                },
                {
                    twitterUserName:
                        this.runtime.getSetting("TWITTER_USERNAME"),
                    timeline: formattedHomeTimeline,
                }
            );

            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.twitterPostTemplate ||
                    twitterPostTemplate,
            });

            const newTweetContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.MEDIUM,
            });

            // Replace \n with proper line breaks and trim excess spaces
            const formattedTweet = newTweetContent
                .replaceAll(/\\n/g, "\n")
                .trim();

            // Use the helper function to truncate to complete sentence
            const content = truncateToCompleteSentence(formattedTweet);

            try {
                const result = await this.requestQueue.add(
                    async () => await this.twitterClient.sendTweet(content)
                );
                const body = await result.json();
                const tweetResult = body.data.create_tweet.tweet_results.result;

                const tweet = {
                    id: tweetResult.rest_id,
                    text: tweetResult.legacy.full_text,
                    conversationId: tweetResult.legacy.conversation_id_str,
                    createdAt: tweetResult.legacy.created_at,
                    userId: tweetResult.legacy.user_id_str,
                    inReplyToStatusId:
                        tweetResult.legacy.in_reply_to_status_id_str,
                    permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
                    hashtags: [],
                    mentions: [],
                    photos: [],
                    thread: [],
                    urls: [],
                    videos: [],
                } as Tweet;

                const postId = tweet.id;
                const conversationId =
                    tweet.conversationId + "-" + this.runtime.agentId;
                const roomId = stringToUuid(conversationId);

                await this.runtime.ensureRoomExists(roomId);
                await this.runtime.ensureParticipantInRoom(
                    this.runtime.agentId,
                    roomId
                );

                await this.cacheTweet(tweet);

                await this.runtime.messageManager.createMemory({
                    id: stringToUuid(postId + "-" + this.runtime.agentId),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: newTweetContent.trim(),
                        url: tweet.permanentUrl,
                        source: "twitter",
                    },
                    roomId,
                    embedding: embeddingZeroVector,
                    createdAt: tweet.timestamp * 1000,
                });
            } catch (error) {
                console.error("Error sending tweet:", error);
            }
        } catch (error) {
            console.error("Error generating new tweet:", error);
        }
    }

    /**
     * Generate a new tweet with an image.
     * Requirements:
     * - Generate a tweet content
     * - Generate an image prompt based the tweet content
     * - Generate an image with the prompt
     * - Send the tweet with the image
     */
    private async generateNewTweetWithImage() {
        elizaLogger.log("Generating new tweet with image");
        try {
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.runtime.getSetting("TWITTER_USERNAME"),
                this.runtime.character.name,
                "twitter"
            );

            // First generate tweet content
            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: stringToUuid("twitter_generate_room"),
                    agentId: this.runtime.agentId,
                    content: { text: "", action: "" },
                },
                {
                    twitterUserName:
                        this.runtime.getSetting("TWITTER_USERNAME"),
                }
            );

            const context = composeContext({
                state,
                template: this.runtime.character.templates?.twitterPostTemplate || twitterPostTemplate,
            });

            const newTweetContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.MEDIUM,
            });

            const formattedTweet = newTweetContent.replaceAll(/\\n/g, "\n").trim();
            const content = truncateToCompleteSentence(formattedTweet);

            console.log("💬 Tweet content:", content);

            // Generate enhanced image prompt from the tweet content
            const SUBJECT    = this.runtime.character.appearance?.description || this.runtime.character.name;
            const CONTENT = content;
            const STYLE = this.runtime.character.appearance?.imageStyle || "";
            
            const IMAGE_SYSTEM_PROMPT = `You are an expert in writing prompts for AI art generation. You excel at creating detailed and creative visual descriptions. Incorporating specific elements naturally. Always aim for clear, descriptive language that generates a creative picture. Your output should only contain the description of the image contents, but NOT an instruction like "create an image that..."`;

            const IMAGE_PROMPT_INPUT = `You are tasked with generating an image prompt based on a tweet post, a given subject, and a specified style. 
            Your goal is to create a detailed and vivid image prompt that captures the essence of the tweet while incorporating the provided subject and style.\n\nYou will be given the following inputs:\n<tweet_text>\n${CONTENT}\n</tweet_text>\n\n<subject>\n${SUBJECT}\n</subject> \nImportant: \"${SUBJECT}\" must be included without changing this sentence.\n\n<style>\n${STYLE}\n</style>\n\nA good image prompt consists of the following elements:\n1. Main subject\n2. Detailed description\n3. Style\n4. Lighting\n5. Composition\n6. Quality modifiers\n\nTo generate the image prompt, follow these steps:\n\n1. Analyze the tweet text carefully, identifying key themes, emotions, and visual elements mentioned or implied.\n\n2. Consider how the given subject relates to the tweet's content. If there's no clear connection, think creatively about how to incorporate the subject in a way that complements the tweet's message.\n\n3. Determine an appropriate environment or setting based on the tweet's context and the given subject.\n\n4. Decide on suitable lighting that enhances the mood or atmosphere of the scene.\n\n5. Choose a color palette that reflects the tweet's tone and complements the subject and style.\n\n6. Identify the overall mood or emotion conveyed by the tweet.\n\n7. Plan a composition that effectively showcases the subject and captures the tweet's essence.\n\n8. Incorporate the specified style into your description, considering how it affects the overall look and feel of the image.\n\n9. Use concrete nouns and avoid abstract concepts when describing the main subject and elements of the scene.\n\nConstruct your image prompt using the following structure:\n\n1. Main subject: Describe the primary focus of the image, incorporating the given subject.\n2. Environment: Detail the setting or background.\n3. Lighting: Specify the type and quality of light in the scene.\n4. Colors: Mention the key colors and their relationships.\n5. Mood: Convey the overall emotional tone.\n6. Composition: Describe how elements are arranged in the frame.\n7. Style: Incorporate the given style into the description.\n\nEnsure that your prompt is detailed, vivid, and incorporates all the elements mentioned above while staying true to the tweet's content, the given subject, and the specified style. LIMIT the image prompt 50 words or less. \n\nWrite a prompt. Only include the prompt and nothing else.`;

            console.log("🎨 Image prompt input:", IMAGE_PROMPT_INPUT);



            const enhancedPrompt = await generateText({
                runtime: this.runtime,
                context: IMAGE_PROMPT_INPUT,
                modelClass: ModelClass.MEDIUM,
                customSystemPrompt: IMAGE_SYSTEM_PROMPT,
            });
            console.log("🎨 Enhanced prompt:", enhancedPrompt);
            

            // input prompt to generate image
            const imagePrompt = enhancedPrompt.replaceAll(/<image_prompt>/g, "").replaceAll(/<\/image_prompt>/g, "").trim();
            console.log("🎨 Image prompt:", imagePrompt);

            // Generate image with enhanced prompt
            const imageResult = await generateImage(
                {
                    prompt: imagePrompt,
                    width: 1024,
                    height: 1024,
                    count: 1,
                },
                this.runtime
            );

            if (!imageResult.success || !imageResult.data || imageResult.data.length === 0) {
                throw new Error("Failed to generate image");
            }

            // Ensure we have a valid base64 string
            const base64Data = imageResult.data[0];
            if (!base64Data) {
                throw new Error("No image data received");
            }

            // Handle both URL and base64 formats
            const imageBuffer = base64Data.startsWith('http') 
                ? await (async () => {
                    const response = await fetch(base64Data);
                    if (!response.ok) {
                        throw new Error(`Failed to fetch image: ${response.statusText}`);
                    }
                    return Buffer.from(await response.arrayBuffer());
                })()
                : Buffer.from(
                    base64Data.replace(/^data:image\/\w+;base64,/, ""),
                    'base64'
                );

            try {
                const tweetResponse = await this.requestQueue.add(
                    async () => await this.twitterClient.sendTweetWithMedia(content, [imageBuffer])
                );

                if (!tweetResponse.ok) {
                    throw new Error(`Failed to send tweet: ${tweetResponse.statusText}`);
                }

                const responseBody = await tweetResponse.json();
                if (!responseBody?.data?.create_tweet?.tweet_results?.result) {
                    throw new Error("Invalid response format from Twitter API");
                }

                const tweetResult = responseBody.data.create_tweet.tweet_results.result;
                const mediaUrl = responseBody.data?.create_tweet?.tweet_results?.result?.legacy?.entities?.media?.[0]?.media_url_https;

                const tweet = {
                    id: tweetResult.rest_id,
                    text: tweetResult.legacy.full_text,
                    conversationId: tweetResult.legacy.conversation_id_str,
                    createdAt: tweetResult.legacy.created_at,
                    userId: tweetResult.legacy.user_id_str,
                    inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
                    permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
                    hashtags: [],
                    mentions: [],
                    photos: [{
                        id: `${tweetResult.rest_id}_photo`,
                        url: mediaUrl || base64Data,
                        alt_text: "Generated image"
                    }],
                    thread: [],
                    urls: [],
                    videos: [],
                } as Tweet;

                const postId = tweet.id;
                const conversationId = tweet.conversationId + "-" + this.runtime.agentId;
                const roomId = stringToUuid(conversationId);

                await this.runtime.ensureRoomExists(roomId);
                await this.runtime.ensureParticipantInRoom(
                    this.runtime.agentId,
                    roomId
                );

                await this.cacheTweet(tweet);

                await this.runtime.messageManager.createMemory({
                    id: stringToUuid(postId + "-" + this.runtime.agentId),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: newTweetContent.trim(),
                        url: tweet.permanentUrl,
                        source: "twitter",
                    },
                    roomId,
                    embedding: embeddingZeroVector,
                    createdAt: tweet.timestamp * 1000,
                });
            } catch (error) {
                console.error("Error sending tweet with image:", error);
                throw error;
            }
        } catch (error) {
            console.error("Error generating new tweet with image:", error);
            throw error;
        }
    }
}
