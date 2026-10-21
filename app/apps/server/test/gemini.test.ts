import { expect, test } from "bun:test";

import { answer, translate } from "../src/gemini.ts";

test("a_gateway_request_becomes_gemini_and_its_answer_comes_back_as_the_gateways", () => {
  const { model, body } = translate({
    model: "google/gemini-3.8-flash",
    reasoning: { effort: "low" },
    messages: [
      { role: "system", content: "Be brief." },
      {
        role: "user",
        content: [
          { type: "text", text: "Who speaks?" },
          { type: "file", file: { filename: "w.mp4", file_data: "data:video/mp4;base64,AAAA" } },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } },
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: { name: "who", strict: true, schema: { type: "object" } } },
  });
  expect(model).toBe("gemini-3.8-flash");
  expect(body).toEqual({
    contents: [
      {
        role: "user",
        parts: [{ text: "Who speaks?" }, { inline_data: { mime_type: "video/mp4", data: "AAAA" } }, { inline_data: { mime_type: "image/jpeg", data: "BBBB" } }],
      },
    ],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: { type: "object" } },
    systemInstruction: { parts: [{ text: "Be brief." }] },
  });
  expect(answer({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: '{"a":' }, { text: "1}" }] } }] })).toEqual({
    choices: [{ message: { content: '{"a":1}' } }],
    usage: { cost: 0 },
  });
});
