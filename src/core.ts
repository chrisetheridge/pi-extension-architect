import path from "node:path";
import type { ArchitectConfig, ArchitectureOption, TaskType } from "./types.js";

export const DEFAULT_CONFIG: ArchitectConfig = {
  autoTriggerAmbiguous: false,
  savePlans: true,
};

export type ArchitectCommandAction = "start" | "disable" | "enable";

export function normalizeConfig(input: Partial<ArchitectConfig> | undefined): ArchitectConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(input ?? {}),
    autoTriggerAmbiguous: input?.autoTriggerAmbiguous ?? DEFAULT_CONFIG.autoTriggerAmbiguous,
    savePlans: input?.savePlans ?? DEFAULT_CONFIG.savePlans,
  };
}

export function parseTaskType(text: string): TaskType | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? text.trim();

  try {
    const parsed = JSON.parse(candidate) as { taskType?: string; type?: string };
    return coerceTaskType(parsed.taskType ?? parsed.type);
  } catch {
    const match = candidate.match(/\b(trivial|implementation|architectural|ambiguous)\b/i);
    return match ? coerceTaskType(match[1]) : null;
  }
}

export function coerceTaskType(value: string | undefined): TaskType | null {
  if (value === "trivial" || value === "implementation" || value === "architectural" || value === "ambiguous") {
    return value;
  }
  return null;
}

export function heuristicClassify(prompt: string): TaskType {
  const normalized = prompt.toLowerCase();

  if (/^(fix typo|format|rename|explain|what is|show me|list|read)\b/.test(normalized)) {
    return "trivial";
  }

  const architecturalSignals = [
    "architecture",
    "architect",
    "design",
    "system",
    "from scratch",
    "scalable",
    "migration",
    "multi-tenant",
    "queue",
    "database schema",
    "authentication",
    "authorization",
    "workflow",
    "platform",
    "extension",
  ];

  if (architecturalSignals.some((signal) => normalized.includes(signal))) {
    return "architectural";
  }

  if (/\b(build|implement|create|add|refactor)\b/.test(normalized)) {
    return "implementation";
  }

  return "ambiguous";
}

export function shouldEnterArchitectMode(taskType: TaskType, config: ArchitectConfig): boolean {
  if (taskType === "architectural") return true;
  if (taskType === "ambiguous") return config.autoTriggerAmbiguous;
  return false;
}

export function buildArchitectEntryReason(taskType: TaskType, source: "manual" | "automatic"): string {
  if (source === "manual") {
    return "You started Architect Mode manually, let's spend time working through your problem.";
  }

  if (taskType === "architectural") {
    return "This request looks architectural, let's spend time working through it before I write code.";
  }

  return "This request was treated as ambiguous, let's spend time working through it before I write code.";
}

export function parseArchitectCommandArgs(args: string): ArchitectCommandAction {
  const firstToken = args.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";

  if (firstToken === "disable" || firstToken === "off" || firstToken === "stop") {
    return "disable";
  }

  if (firstToken === "enable" || firstToken === "on") {
    return "enable";
  }

  return "start";
}

export function parseArchitectureOptions(text: string): ArchitectureOption[] {
  const jsonText = extractJsonObject(text);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as { options?: Array<Partial<ArchitectureOption>> };
      const options = parsed.options?.map((option, index) => normalizeOption(option, index)).filter(Boolean);
      if (options?.length) return options as ArchitectureOption[];
    } catch {
      // Fall through to markdown parsing.
    }
  }

  const sections = text.split(/\n(?=#{2,4}\s+|Option\s+[A-C]\b)/i);
  const options = sections
    .map((section, index) => {
      const trimmed = section.trim();
      if (!trimmed) return null;
      const firstLine = trimmed.split("\n")[0]?.replace(/^#{2,4}\s+/, "").trim() ?? `Option ${index + 1}`;
      if (!/\boption\b|simple|scalable|maintainable|conservative/i.test(firstLine)) return null;
      return normalizeOption(
        {
          title: firstLine,
          summary: trimmed.split("\n").slice(1, 3).join(" ").trim() || firstLine,
          details: trimmed,
        },
        index,
      );
    })
    .filter(Boolean) as ArchitectureOption[];

  return options.slice(0, 3);
}

export function fallbackArchitectureOptions(): ArchitectureOption[] {
  return [
    {
      id: "simple",
      title: "Option A - Simple / Fast to Build",
      summary: "Keep the design minimal and optimize for getting a working path quickly.",
      details:
        "Use the fewest moving parts, local state where possible, and direct control flow. This is easiest to build and review, but may need refactoring if scale or reliability constraints grow.",
    },
    {
      id: "maintainable",
      title: "Option B - Conservative / Maintainable",
      summary: "Use clear module boundaries and explicit decision records without adding heavy infrastructure.",
      details:
        "Separate classification, Socratic collection, critique, option generation, and implementation context. This costs a bit more upfront but keeps the system easier to evolve.",
    },
  ];
}

export function slugifyPlanName(prompt: string, maxLength = 48): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "architect-plan";
}

export function buildPlanPath(cwd: string, prompt: string, date = new Date()): string {
  const yyyyMmDd = date.toISOString().slice(0, 10);
  return path.join(cwd, ".pi", "architect", `PLAN-${slugifyPlanName(prompt)}-${yyyyMmDd}.md`);
}

function normalizeOption(option: Partial<ArchitectureOption>, index: number): ArchitectureOption | null {
  const title = option.title?.trim();
  const details = option.details?.trim() || option.summary?.trim();
  if (!title || !details) return null;

  return {
    id: option.id?.trim() || `option-${index + 1}`,
    title,
    summary: option.summary?.trim() || details.split("\n")[0] || title,
    details,
  };
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}
