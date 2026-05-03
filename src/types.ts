export type TaskType = "trivial" | "implementation" | "architectural" | "ambiguous";

export interface ArchitectConfig {
  classifierModel?: string;
  architectModel?: string;
  prompts?: ArchitectPromptConfig;
  autoTriggerAmbiguous: boolean;
  savePlans: boolean;
}

export interface ArchitectPromptConfig {
  classifier?: string;
  review?: string;
  options?: string;
}

export interface SocraticQuestion {
  id: string;
  title: string;
  prompt: string;
}

export interface SocraticAnswer {
  questionId: string;
  title: string;
  prompt: string;
  answer: string;
}

export interface ArchitectureOption {
  id: string;
  title: string;
  summary: string;
  details: string;
}

export interface ArchitectDecision {
  originalPrompt: string;
  taskType: TaskType;
  answers: SocraticAnswer[];
  reviewFeedback: string;
  followUpAnswers: string;
  options: ArchitectureOption[];
  selectedApproach: string;
  selectedApproachDetails: string;
  savedPlanPath?: string;
  createdAt: string;
}
