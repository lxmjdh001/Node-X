export const MAX_VARIANTS = 50;
export const MAX_BULK_DELETE_IDS = 500;
export const MAX_SOURCE_TEXT = 8000;
export const MAX_POST_LINK = 2048;
export const MAX_FORMAT_REQUIREMENTS = 500;

export const postLayouts = {
  automatic: '自动排版',
  sentenceLines: '每句换行',
} as const;

export type PostLayout = keyof typeof postLayouts;

export const assignmentModes = {
  oneAccount: '一个账号发一条或多条',
  oneEach: '多个账号各发不同的一条',
  samePost: '同一条发给多个账号',
} as const;

export type AssignmentMode = keyof typeof assignmentModes;

export type PendingPost = {
  id: string;
  sourceUrl: string | null;
  text: string;
  variant: number;
  generatedBy: string | null;
  assignedCount: number;
};
