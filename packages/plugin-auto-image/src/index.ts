// packages/plugin-auto-image/src/index.ts
import { 
    Plugin, 
    IAgentRuntime, 
    generateImage, 
    generateText,
    ModelClass,
    Message 
} from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";

const IMAGE_PROMPT_SYSTEM = `You are an expert in creating prompts for AI art. Important techniques to create high-quality prompts:
- Include the character's appearance exactly as provided
- Add creative scene composition and background
- Be descriptive about lighting and atmosphere
- Keep descriptions under 80 words
- Be direct and straightforward
- Avoid metaphors or "like" comparisons`;

export class AutoImageGenerator {
    runtime: IAgentRuntime;
    interval: NodeJS.Timeout;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        
        // Generate image every 2-4 hours
        const randomInterval = () => Math.floor(Math.random() * (4 - 2 + 1) + 2) * 60 * 60 * 1000;
        
        this.interval = setInterval(async () => {
            await this.generateAndTweet();
        }, randomInterval());
    }

    async generateAndTweet() {
        try {
            const appearance = this.runtime.character.appearance?.description;
            if (!appearance) {
                console.log("No appearance description found in character config");
                return;
            }

            const examples = this.runtime.character.appearance?.imagePromptExamples || [];
            const examplesText = examples.length > 0 ? 
                "Follow these examples:\n" + examples.join("\n") + "\n" : "";

            const promptTemplate = `Create a high-quality and creative prompt. You must include "${appearance}" in the prompt without changing any texts of this definition, and describe what the image looks like in full details.

${examplesText}
Task: create a random prompt. The prompt must be descriptive and must not be imperative. Add variation to the image contents and composition. Avoid using metaphors. Do not say "something is like something" but always be direct and straightforward. Use less than 80 words. Write a prompt. Only include the prompt and nothing else.`;

            // Generate enhanced prompt
            const imagePrompt = await generateText({
                runtime: this.runtime,
                context: promptTemplate + "\n\n" + IMAGE_PROMPT_SYSTEM,
                modelClass: ModelClass.SMALL,
            });

            // Remove quotes if present
            const cleanPrompt = imagePrompt.replace(/^["'](.*)["']$/, "$1");

            // Generate image
            const result = await generateImage(
                {
                    prompt: cleanPrompt,
                    width: 1024,
                    height: 1024,
                    count: 1,
                },
                this.runtime
            );

            if (result.success && result.data && result.data.length > 0) {
                // Create tweet with image
                const message: Message = {
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    roomId: stringToUuid("auto_image_room"),
                    content: {
                        text: "✨ New art generated",
                        action: "TWEET_WITH_IMAGE",
                        imageData: result.data[0]
                    }
                };

                // Send message to runtime
                // await this.runtime.sendMessage(message);
                await this.runtime.updateRecentMessageState(message);
            }
        } catch (error) {
            console.error("Error in auto image generation:", error);
        }
    }
}

export const autoImagePlugin: Plugin = {
    name: "auto-image",
    setup: async (runtime: IAgentRuntime) => {
        new AutoImageGenerator(runtime);
    }
};