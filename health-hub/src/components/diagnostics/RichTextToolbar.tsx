import { useMemo } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Highlighter,
  Italic,
  List,
  ListOrdered,
  Redo2,
  Type,
  Underline,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  NARRATIVE_FONT_FAMILIES,
  NARRATIVE_FONT_SIZE_OPTIONS,
} from '@/lib/richText';
import type { ToolbarState } from './RichTextSurface';

const BLOCK_SELECTOR_OPTIONS = [
  { label: 'Paragraph', value: 'p' },
  { label: 'Heading 1', value: 'h1' },
  { label: 'Heading 2', value: 'h2' },
  { label: 'Heading 3', value: 'h3' },
] as const;

interface RichTextToolbarProps {
  state: ToolbarState;
  onCommand: (command: string, value?: string) => void;
  /** When false, the toolbar still renders but its controls are visually muted and skip mousedown.preventDefault. Use to indicate no editor is focused. */
  active?: boolean;
  className?: string;
}

export function RichTextToolbar({ state, onCommand, active = true, className }: RichTextToolbarProps) {
  const toolbarButtonClassName = useMemo(
    () =>
      'h-8 w-8 rounded-md border border-transparent p-0 text-muted-foreground hover:border-border hover:bg-white hover:text-foreground',
    []
  );

  const dispatch = (command: string, value?: string) => onCommand(command, value);

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/95 px-3 py-2 shadow-sm backdrop-blur',
        !active && 'opacity-60',
        className
      )}
    >
      <select
        value={state.block}
        onChange={(event) => dispatch('formatBlock', `<${event.target.value}>`)}
        className="h-8 rounded-md border border-border bg-white px-2 text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/25"
      >
        {BLOCK_SELECTOR_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <select
        value={state.fontFamily}
        onChange={(event) => dispatch('fontName', event.target.value)}
        className="h-8 rounded-md border border-border bg-white px-2 text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/25"
      >
        {NARRATIVE_FONT_FAMILIES.map((fontFamily) => (
          <option key={fontFamily} value={fontFamily}>
            {fontFamily}
          </option>
        ))}
      </select>

      <select
        value={state.fontSize}
        onChange={(event) => dispatch('fontSize', event.target.value)}
        className="h-8 w-20 rounded-md border border-border bg-white px-2 text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/25"
      >
        {NARRATIVE_FONT_SIZE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <div className="mx-1 h-6 w-px bg-slate-200" />

      <Button
        type="button"
        variant="ghost"
        className={cn(toolbarButtonClassName, state.bold && 'border-border bg-white text-foreground')}
        onMouseDown={(event) => {
          event.preventDefault();
          dispatch('bold');
        }}
        title="Bold"
      >
        <Bold className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={cn(toolbarButtonClassName, state.italic && 'border-border bg-white text-foreground')}
        onMouseDown={(event) => {
          event.preventDefault();
          dispatch('italic');
        }}
        title="Italic"
      >
        <Italic className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={cn(toolbarButtonClassName, state.underline && 'border-border bg-white text-foreground')}
        onMouseDown={(event) => {
          event.preventDefault();
          dispatch('underline');
        }}
        title="Underline"
      >
        <Underline className="h-4 w-4" />
      </Button>

      <div className="mx-1 h-6 w-px bg-slate-200" />

      <Button
        type="button"
        variant="ghost"
        className={cn(toolbarButtonClassName, state.alignment === 'left' && 'border-border bg-white text-foreground')}
        onMouseDown={(event) => {
          event.preventDefault();
          dispatch('justifyLeft');
        }}
        title="Align left"
      >
        <AlignLeft className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={cn(toolbarButtonClassName, state.alignment === 'center' && 'border-border bg-white text-foreground')}
        onMouseDown={(event) => {
          event.preventDefault();
          dispatch('justifyCenter');
        }}
        title="Align center"
      >
        <AlignCenter className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={cn(toolbarButtonClassName, state.alignment === 'right' && 'border-border bg-white text-foreground')}
        onMouseDown={(event) => {
          event.preventDefault();
          dispatch('justifyRight');
        }}
        title="Align right"
      >
        <AlignRight className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={cn(toolbarButtonClassName, state.alignment === 'justify' && 'border-border bg-white text-foreground')}
        onMouseDown={(event) => {
          event.preventDefault();
          dispatch('justifyFull');
        }}
        title="Justify"
      >
        <AlignJustify className="h-4 w-4" />
      </Button>

      <div className="mx-1 h-6 w-px bg-slate-200" />

      <Button
        type="button"
        variant="ghost"
        className={cn(toolbarButtonClassName, state.unorderedList && 'border-border bg-white text-foreground')}
        onMouseDown={(event) => {
          event.preventDefault();
          dispatch('insertUnorderedList');
        }}
        title="Bulleted list"
      >
        <List className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={cn(toolbarButtonClassName, state.orderedList && 'border-border bg-white text-foreground')}
        onMouseDown={(event) => {
          event.preventDefault();
          dispatch('insertOrderedList');
        }}
        title="Numbered list"
      >
        <ListOrdered className="h-4 w-4" />
      </Button>

      <div className="mx-1 h-6 w-px bg-slate-200" />

      <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-white px-2 text-xs text-muted-foreground shadow-sm">
        <Type className="h-3.5 w-3.5" />
        <span>Text</span>
        <input
          type="color"
          value={state.textColor}
          onChange={(event) => dispatch('foreColor', event.target.value)}
          className="h-5 w-5 cursor-pointer border-0 bg-transparent p-0"
          title="Text color"
        />
      </label>

      <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-white px-2 text-xs text-muted-foreground shadow-sm">
        <Highlighter className="h-3.5 w-3.5" />
        <span>Highlight</span>
        <input
          type="color"
          value={state.highlightColor}
          onChange={(event) => dispatch('hiliteColor', event.target.value)}
          className="h-5 w-5 cursor-pointer border-0 bg-transparent p-0"
          title="Highlight color"
        />
      </label>

      <div className="mx-1 h-6 w-px bg-slate-200" />

      <Button
        type="button"
        variant="ghost"
        className={toolbarButtonClassName}
        onMouseDown={(event) => {
          event.preventDefault();
          dispatch('undo');
        }}
        title="Undo"
      >
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={toolbarButtonClassName}
        onMouseDown={(event) => {
          event.preventDefault();
          dispatch('redo');
        }}
        title="Redo"
      >
        <Redo2 className="h-4 w-4" />
      </Button>
    </div>
  );
}
