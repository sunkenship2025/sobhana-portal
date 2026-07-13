import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  RichTextSurface,
  type RichTextSurfaceHandle,
  type ToolbarState,
  DEFAULT_TOOLBAR_STATE,
} from './RichTextSurface';
import { RichTextToolbar } from './RichTextToolbar';

interface RichTextNarrativeEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeightClassName?: string;
  className?: string;
  /** Overrides on the editable surface (font size, leading, padding) so the
   *  editor can match a compact target like the report Comments box. */
  contentClassName?: string;
}

export function RichTextNarrativeEditor({
  value,
  onChange,
  placeholder = 'Start writing the narrative report...',
  minHeightClassName = 'min-h-[320px]',
  className,
  contentClassName,
}: RichTextNarrativeEditorProps) {
  const surfaceRef = useRef<RichTextSurfaceHandle>(null);
  const [toolbarState, setToolbarState] = useState<ToolbarState>(DEFAULT_TOOLBAR_STATE);

  return (
    <div className={cn('overflow-hidden rounded-2xl border border-border bg-white shadow-sm', className)}>
      <div className="border-b border-border bg-muted/80 px-3 py-2">
        <RichTextToolbar
          state={toolbarState}
          onCommand={(command, valueArg) => surfaceRef.current?.runCommand(command, valueArg)}
          className="border-transparent bg-transparent shadow-none"
        />
      </div>

      <div className="bg-[linear-gradient(180deg,#ffffff_0%,#fbfdff_100%)] px-4 py-4">
        <RichTextSurface
          ref={surfaceRef}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          onToolbarStateChange={setToolbarState}
          contentClassName={cn(
            'rich-text-narrative-editor w-full rounded-xl border border-border bg-white px-6 py-5 text-[15px] leading-7 text-foreground shadow-[0_10px_30px_-20px_rgba(15,23,42,0.4)] outline-none transition focus-within:border-primary/40 focus-within:shadow-[0_12px_36px_-18px_rgba(37,99,235,0.3)]',
            minHeightClassName,
            contentClassName
          )}
        />
      </div>
    </div>
  );
}
