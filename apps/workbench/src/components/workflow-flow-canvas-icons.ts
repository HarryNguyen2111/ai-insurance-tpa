import { Bot, CircleStop, Hourglass, Inbox, Play, Split, UserCheck, type LucideIcon } from 'lucide-react';
import type { NodeType } from '@/lib/workflow-definition';

// Shared by the eager palette and the lazily loaded canvas; must not import @xyflow/react.
export const NODE_DRAG_TYPE = 'application/x-tpa-node';
export const NODE_ICONS: Record<NodeType, LucideIcon> = {
  START: Play, END: CircleStop, HUMAN_TASK: UserCheck, AI_ACTIVITY: Bot, CONDITION: Split, SUPPLEMENT_WAIT: Inbox, TIMER: Hourglass,
};
