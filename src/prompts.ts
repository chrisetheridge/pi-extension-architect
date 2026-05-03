import type { SocraticAnswer } from "./types.js";

export type PromptName = "classifier" | "review" | "options";

export interface ClassifierPromptInput {
  prompt: string;
  repoContext: string;
}

export interface ReviewPromptInput {
  originalPrompt: string;
  answers: SocraticAnswer[];
}

export interface OptionsPromptInput {
  originalPrompt: string;
  answers: SocraticAnswer[];
  reviewFeedback: string;
  followUpAnswers: string;
}

export const SYSTEM_PROMPTS = {
  classifier: "You are a strict task classifier.",
  architectReviewer: "You are an architecture reviewer.",
  architectCoach: "You are an architecture reviewer and Socratic design coach.",
} as const;

export const DEFAULT_PROMPT_TEMPLATES: Record<PromptName, string> = {
  classifier: `Classify this Pi coding-agent user request.

Return ONLY JSON: {"taskType":"trivial"|"implementation"|"architectural"|"ambiguous","reason":"short"}

Definitions:
- trivial: explanation, reading, typo, tiny mechanical edit
- implementation: straightforward code change with local scope
- architectural: needs system design, significant structure, tradeoffs, data flow, reliability, scalability, security, or from-scratch feature planning
- ambiguous: not enough information

User request:
{{prompt}}

Repo context:
{{repoContext}}`,
  review: `The user wants to implement this task:
{{originalPrompt}}

They answered these architecture questions:
{{answers}}

Critique their thinking in a Socratic style.

Requirements:
- Identify missing constraints, flawed assumptions, hidden complexity, failure modes, and scalability risks.
- Ask probing follow-up questions.
- Do NOT generate implementation.
- Do NOT choose a final solution.
- Be concise but specific.`,
  options: `Generate 2-3 architecture options for this task.

Original task:
{{originalPrompt}}

User design answers:
{{answers}}

Review feedback:
{{reviewFeedback}}

User refinements:
{{followUpAnswers}}

Return JSON only:
{
  "options": [
    {
      "id": "simple",
      "title": "Option A - Simple / Fast to Build",
      "summary": "one sentence",
      "details": "High-level structure, components, data flow, tradeoffs, failure modes, complexity level."
    }
  ]
}`,
};

export function buildClassifierPrompt(input: ClassifierPromptInput, template = DEFAULT_PROMPT_TEMPLATES.classifier): string {
  return renderPromptTemplate(template, {
    prompt: input.prompt,
    repoContext: input.repoContext,
  });
}

export function buildReviewPrompt(input: ReviewPromptInput, template = DEFAULT_PROMPT_TEMPLATES.review): string {
  return renderPromptTemplate(template, {
    originalPrompt: input.originalPrompt,
    answers: formatAnswers(input.answers),
  });
}

export function buildOptionsPrompt(input: OptionsPromptInput, template = DEFAULT_PROMPT_TEMPLATES.options): string {
  return renderPromptTemplate(template, {
    originalPrompt: input.originalPrompt,
    answers: formatAnswers(input.answers),
    reviewFeedback: input.reviewFeedback,
    followUpAnswers: input.followUpAnswers || "(none)",
  });
}

export function formatAnswers(answers: SocraticAnswer[]): string {
  return answers.map((answer) => `### ${answer.title}\n\nQuestion: ${answer.prompt}\n\nAnswer: ${answer.answer}`).join("\n\n");
}

export function renderPromptTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => variables[key] ?? match);
}
