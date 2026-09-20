import { expect, test, vi } from "vitest";
import { createDesktopChatGptProvider } from "./chatgpt-provider";

// Exercise the native SDK's request and SSE parser, including tool continuation.
test.each(["stream", "streamSimple"] as const)("%s uses desktop HTTP transport and returns assistant text", async method => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toMatch(/^Bearer /);
        const events = [
            {type:"response.created", response:{id:"resp-test",status:"in_progress"}},
            {type:"response.output_item.added",output_index:0,item:{type:"message",id:"msg-test",role:"assistant",content:[]}},
            {type:"response.content_part.added",output_index:0,content_index:0,part:{type:"output_text",text:"",annotations:[]}},
            {type:"response.output_text.delta",output_index:0,content_index:0,delta:"Connected"},
            {type:"response.output_item.done",output_index:0,item:{type:"message",id:"msg-test",role:"assistant",content:[{type:"output_text",text:"Connected",annotations:[]}]}},
            {type:"response.completed",response:{id:"resp-test",status:"completed",usage:{input_tokens:1,output_tokens:1,total_tokens:2}}},
        ];
        return new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
    });
    const provider = createDesktopChatGptProvider(fetch);
    const model = provider.getModels()[0]!;
    const token = `test.${Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"test-account"}})).toString("base64url")}.test`;
    const result = await provider[method](model,{messages:[{role:"user",content:"hello",timestamp:0}]},{apiKey:token}).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toContainEqual(expect.objectContaining({type:"text",text:"Connected"}));
    expect(fetch).toHaveBeenCalledOnce();
});
