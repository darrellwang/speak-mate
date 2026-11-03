/**
 * 纠错卡片（架构文档 §2 components/chat/CorrectionCard.tsx，P0-3）。
 *
 * 折叠态：一行摘要（如「2 处表达可优化」），不打断对话流；
 * 展开态：逐条四要素 ❌原句 → ⚠️问题类型 → ✅正确说法 → 💡一句话讲解。
 * 无纠错（corrections 为空）不渲染——不硬纠。
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import type { Correction } from '@shared/types/chat';
// 问题类型文案与 SettingsPage 共用一份（审查报告 L2）
import { issueLabel } from '@shared/constants';

interface CorrectionCardProps {
  corrections: Correction[];
}

function CorrectionRow({ correction, index }: { correction: Correction; index: number }): ReactNode {
  return (
    <Box
      key={index}
      sx={{ bgcolor: 'action.hover', borderRadius: 1.5, p: 1.25 }}
      className="flex flex-col gap-1"
    >
      <Box className="flex flex-wrap items-center gap-1.5">
        <Chip label={issueLabel(correction.issue)} size="small" color="warning" variant="outlined" />
        <Box component="span" className="text-[13px]" sx={{ color: 'text.secondary', wordBreak: 'break-word' }}>
          ❌ {correction.original}
        </Box>
      </Box>
      <Box className="text-[14px]" sx={{ wordBreak: 'break-word' }}>
        ✅ {correction.corrected}
      </Box>
      <Box className="text-[12.5px] leading-relaxed" sx={{ color: 'text.secondary' }}>
        💡 {correction.explanation}
      </Box>
    </Box>
  );
}

export default function CorrectionCard({ corrections }: CorrectionCardProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  if (corrections.length === 0) return null;

  const summary =
    corrections.length === 1 ? '1 处表达可优化' : `${corrections.length} 处表达可优化`;

  return (
    <Card
      variant="outlined"
      sx={{ width: '100%', maxWidth: '75%', borderRadius: 2, overflow: 'hidden' }}
    >
      <Box
        component="button"
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
        sx={{
          minHeight: 44,
          border: 0,
          bgcolor: 'transparent',
          color: 'text.primary',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: '0.875rem',
        }}
        aria-expanded={expanded}
      >
        <Box component="span" className="flex items-center gap-1.5">
          <span>⚠️</span>
          <span>{summary}</span>
        </Box>
        <Box component="span" sx={{ color: 'text.secondary', fontSize: '0.75rem' }}>
          {expanded ? '收起' : '展开'}
        </Box>
      </Box>
      <Collapse in={expanded} timeout="auto" unmountOnExit>
        <Box px={1.5} pb={1.5} className="flex flex-col gap-1.5">
          {corrections.map((correction, index) => (
            <CorrectionRow key={index} correction={correction} index={index} />
          ))}
        </Box>
      </Collapse>
    </Card>
  );
}
