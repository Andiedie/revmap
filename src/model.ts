export type Side = 'old' | 'new';
export type Priority = 'high' | 'normal' | 'low';

export interface Note {
  text: string;
  line?: number;
  endLine?: number;
  side?: Side;
}
export interface FileInput {
  path: string;
  oldPath?: string;
  priority?: Priority;
  comments?: Note[];
}
export interface GroupInput { title: string; comments?: Note[]; files: FileInput[] }
export interface ReviewInput { base?: string; comments?: Note[]; files?: FileInput[]; groups?: GroupInput[] }
export interface Version {
  text: string | null;
  mode: string;
  bytes: number;
}
export interface ReviewFile {
  path: string;
  oldPath?: string;
  priority: Priority;
  comments: Note[];
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'unchanged';
  kind: 'text' | 'binary' | 'symlink' | 'submodule';
  before: Version | null;
  after: Version | null;
  patch: string;
}
export interface ReviewGroup { title: string; comments: Note[]; files: number[] }
export interface Review {
  comments?: Note[];
  groups?: ReviewGroup[];
  repository: string;
  base: string | null;
  createdAt: string;
  files: ReviewFile[];
}
export function lines(text: string | null | undefined): string[] {
  if (!text) return [];
  const result = text.split('\n');
  if (result[result.length - 1] === '') result.pop();
  return result.map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
}
