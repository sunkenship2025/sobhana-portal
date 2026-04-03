import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  escapeRichTextHtml,
  getFontSizeLabelFromComputedSize,
  hasMeaningfulRichText,
  NARRATIVE_FONT_FAMILIES,
  NARRATIVE_FONT_SIZE_OPTIONS,
  normalizeColorForPicker,
  normalizeFontFamilyForToolbar,
  normalizeRichTextForStorage,
  plainTextToRichText,
  sanitizeRichTextHtml,
} from '@/lib/richText';

type CommandCapableDocument = Document & {
  execCommand?: (commandId: string, showUI?: boolean, value?: string) => boolean;
  queryCommandState?: (commandId: string) => boolean;
};

interface RichTextNarrativeEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeightClassName?: string;
  className?: string;
}

type ToolbarState = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  unorderedList: boolean;
  orderedList: boolean;
  alignment: 'left' | 'center' | 'right' | 'justify';
  block: 'p' | 'h1' | 'h2' | 'h3';
  fontFamily: string;
  fontSize: string;
  textColor: string;
  highlightColor: string;
};

const DEFAULT_TOOLBAR_STATE: ToolbarState = {
  bold: false,
  italic: false,
  underline: false,
  unorderedList: false,
  orderedList: false,
  alignment: 'left',
  block: 'p',
  fontFamily: NARRATIVE_FONT_FAMILIES[0],
  fontSize: '3',
  textColor: '#111827',
  highlightColor: '#fff59d',
};

const BLOCK_SELECTOR_OPTIONS = [
  { label: 'Paragraph', value: 'p' },
  { label: 'Heading 1', value: 'h1' },
  { label: 'Heading 2', value: 'h2' },
  { label: 'Heading 3', value: 'h3' },
] as const;

function getSelectionContainer(editor: HTMLDivElement | null): HTMLElement | null {
  if (!editor) return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return editor;
  }

  const node = selection.anchorNode;
  if (!node) return editor;

  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  return element && editor.contains(element) ? element : editor;
}

function getAlignmentFromComputedStyle(value: string): ToolbarState['alignment'] {
  switch (value) {
    case 'center':
      return 'center';
    case 'right':
      return 'right';
    case 'justify':
      return 'justify';
    default:
      return 'left';
  }
}

function buildPasteHtml(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.trim()) {
    return '';
  }
  return plainTextToRichText(normalized) || `<p>${escapeRichTextHtml(normalized).replace(/\n/g, '<br>')}</p>`;
}

export function RichTextNarrativeEditor({
  value,
  onChange,
  placeholder = 'Start writing the narrative report...',
  minHeightClassName = 'min-h-[320px]',
  className,
}: RichTextNarrativeEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const lastCommittedValueRef = useRef('');
  const [toolbarState, setToolbarState] = useState<ToolbarState>(DEFAULT_TOOLBAR_STATE);

  const toolbarButtonClassName = useMemo(
    () => 'h-8 w-8 rounded-md border border-transparent p-0 text-slate-600 hover:border-slate-300 hover:bg-white hover:text-slate-900',
    []
  );

  const updateEmptyState = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.dataset.empty = hasMeaningfulRichText(editor.innerHTML) ? 'false' : 'true';
  }, []);

  const captureSelection = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) {
      savedRangeRef.current = range.cloneRange();
    }
  }, []);

  const restoreSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || !savedRangeRef.current) {
      return;
    }
    try {
      selection.removeAllRanges();
      selection.addRange(savedRangeRef.current);
    } catch {
      savedRangeRef.current = null;
    }
  }, []);

  const syncToolbarState = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const container = getSelectionContainer(editor);
    const block = container?.closest('h1, h2, h3, p')?.tagName.toLowerCase() as ToolbarState['block'] | null;
    const computedStyle = window.getComputedStyle(container || editor);
    const commandDocument = document as CommandCapableDocument;

    const nextState: ToolbarState = {
      bold:
        commandDocument.queryCommandState?.('bold') ??
        parseInt(computedStyle.fontWeight || '400', 10) >= 600,
      italic:
        commandDocument.queryCommandState?.('italic') ??
        computedStyle.fontStyle === 'italic',
      underline:
        commandDocument.queryCommandState?.('underline') ??
        computedStyle.textDecorationLine.includes('underline'),
      unorderedList: commandDocument.queryCommandState?.('insertUnorderedList') ?? false,
      orderedList: commandDocument.queryCommandState?.('insertOrderedList') ?? false,
      alignment: getAlignmentFromComputedStyle(computedStyle.textAlign),
      block: block || 'p',
      fontFamily: normalizeFontFamilyForToolbar(computedStyle.fontFamily),
      fontSize: getFontSizeLabelFromComputedSize(computedStyle.fontSize),
      textColor: normalizeColorForPicker(computedStyle.color),
      highlightColor: normalizeColorForPicker(container?.style.backgroundColor || '', '#fff59d'),
    };

    setToolbarState(nextState);
  }, []);

  const commitEditorValue = useCallback(
    (nextValue: string, options?: { normalize?: boolean; updateDom?: boolean }) => {
      const editor = editorRef.current;
      const normalized = options?.normalize === false
        ? nextValue
        : normalizeRichTextForStorage(nextValue);
      const finalValue = normalized;

      if (editor && options?.updateDom && editor.innerHTML !== finalValue) {
        editor.innerHTML = finalValue;
      }

      lastCommittedValueRef.current = finalValue;
      updateEmptyState();
      onChange(finalValue);
    },
    [onChange, updateEmptyState]
  );

  const runEditorCommand = useCallback(
    (command: string, valueArg?: string, afterCommand?: () => void) => {
      const editor = editorRef.current;
      const commandDocument = document as CommandCapableDocument;
      if (!editor || !commandDocument.execCommand) {
        return;
      }

      editor.focus({ preventScroll: true });
      restoreSelection();
      commandDocument.execCommand('styleWithCSS', false, 'true');
      commandDocument.execCommand(command, false, valueArg);
      afterCommand?.();
      captureSelection();
      commitEditorValue(editor.innerHTML, { normalize: false });
      syncToolbarState();
    },
    [captureSelection, commitEditorValue, restoreSelection, syncToolbarState]
  );

  const applyBlock = useCallback(
    (blockValue: ToolbarState['block']) => {
      runEditorCommand('formatBlock', `<${blockValue}>`);
    },
    [runEditorCommand]
  );

  const applyFontFamily = useCallback(
    (fontFamily: string) => {
      runEditorCommand('fontName', fontFamily);
    },
    [runEditorCommand]
  );

  const applyFontSize = useCallback(
    (fontSizeCommandValue: string) => {
      runEditorCommand('fontSize', fontSizeCommandValue, () => {
        const editor = editorRef.current;
        const sizePx = NARRATIVE_FONT_SIZE_OPTIONS.find((option) => option.value === fontSizeCommandValue)?.label;
        if (!editor || !sizePx) return;

        editor.querySelectorAll('font[size]').forEach((fontElement) => {
          const sizeValue = fontElement.getAttribute('size');
          if (sizeValue !== fontSizeCommandValue) {
            return;
          }

          const span = document.createElement('span');
          span.style.fontSize = `${sizePx}px`;
          span.innerHTML = fontElement.innerHTML;
          fontElement.replaceWith(span);
        });
      });
    },
    [runEditorCommand]
  );

  const handleInput = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    commitEditorValue(editor.innerHTML, { normalize: false });
    captureSelection();
    syncToolbarState();
  }, [captureSelection, commitEditorValue, syncToolbarState]);

  const handleBlur = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    commitEditorValue(editor.innerHTML, { normalize: true, updateDom: true });
    syncToolbarState();
  }, [commitEditorValue, syncToolbarState]);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();

      const html = event.clipboardData.getData('text/html');
      const text = event.clipboardData.getData('text/plain');
      const pasteHtml = html
        ? sanitizeRichTextHtml(html)
        : buildPasteHtml(text);

      if (!pasteHtml) {
        return;
      }

      runEditorCommand('insertHTML', pasteHtml);
    },
    [runEditorCommand]
  );

  useEffect(() => {
    const nextValue = normalizeRichTextForStorage(value);
    const editor = editorRef.current;
    if (!editor) return;

    if (editor.innerHTML !== nextValue || nextValue !== lastCommittedValueRef.current) {
      editor.innerHTML = nextValue;
      lastCommittedValueRef.current = nextValue;
      updateEmptyState();
      syncToolbarState();
    }
  }, [syncToolbarState, updateEmptyState, value]);

  useEffect(() => {
    const handleSelectionChange = () => {
      const editor = editorRef.current;
      const selection = window.getSelection();
      if (!editor || !selection || selection.rangeCount === 0) {
        return;
      }

      const range = selection.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) {
        return;
      }

      captureSelection();
      syncToolbarState();
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [captureSelection, syncToolbarState]);

  useEffect(() => {
    updateEmptyState();
  }, [updateEmptyState]);

  return (
    <div className={cn('overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm', className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50/80 px-3 py-2">
        <select
          value={toolbarState.block}
          onChange={(event) => applyBlock(event.target.value as ToolbarState['block'])}
          className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/25"
        >
          {BLOCK_SELECTOR_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <select
          value={toolbarState.fontFamily}
          onChange={(event) => applyFontFamily(event.target.value)}
          className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/25"
        >
          {NARRATIVE_FONT_FAMILIES.map((fontFamily) => (
            <option key={fontFamily} value={fontFamily}>
              {fontFamily}
            </option>
          ))}
        </select>

        <select
          value={toolbarState.fontSize}
          onChange={(event) => applyFontSize(event.target.value)}
          className="h-8 w-20 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/25"
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
          className={cn(toolbarButtonClassName, toolbarState.bold && 'border-slate-300 bg-white text-slate-900')}
          onMouseDown={(event) => {
            event.preventDefault();
            runEditorCommand('bold');
          }}
          title="Bold"
        >
          <Bold className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={cn(toolbarButtonClassName, toolbarState.italic && 'border-slate-300 bg-white text-slate-900')}
          onMouseDown={(event) => {
            event.preventDefault();
            runEditorCommand('italic');
          }}
          title="Italic"
        >
          <Italic className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={cn(toolbarButtonClassName, toolbarState.underline && 'border-slate-300 bg-white text-slate-900')}
          onMouseDown={(event) => {
            event.preventDefault();
            runEditorCommand('underline');
          }}
          title="Underline"
        >
          <Underline className="h-4 w-4" />
        </Button>

        <div className="mx-1 h-6 w-px bg-slate-200" />

        <Button
          type="button"
          variant="ghost"
          className={cn(toolbarButtonClassName, toolbarState.alignment === 'left' && 'border-slate-300 bg-white text-slate-900')}
          onMouseDown={(event) => {
            event.preventDefault();
            runEditorCommand('justifyLeft');
          }}
          title="Align left"
        >
          <AlignLeft className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={cn(toolbarButtonClassName, toolbarState.alignment === 'center' && 'border-slate-300 bg-white text-slate-900')}
          onMouseDown={(event) => {
            event.preventDefault();
            runEditorCommand('justifyCenter');
          }}
          title="Align center"
        >
          <AlignCenter className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={cn(toolbarButtonClassName, toolbarState.alignment === 'right' && 'border-slate-300 bg-white text-slate-900')}
          onMouseDown={(event) => {
            event.preventDefault();
            runEditorCommand('justifyRight');
          }}
          title="Align right"
        >
          <AlignRight className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={cn(toolbarButtonClassName, toolbarState.alignment === 'justify' && 'border-slate-300 bg-white text-slate-900')}
          onMouseDown={(event) => {
            event.preventDefault();
            runEditorCommand('justifyFull');
          }}
          title="Justify"
        >
          <AlignJustify className="h-4 w-4" />
        </Button>

        <div className="mx-1 h-6 w-px bg-slate-200" />

        <Button
          type="button"
          variant="ghost"
          className={cn(toolbarButtonClassName, toolbarState.unorderedList && 'border-slate-300 bg-white text-slate-900')}
          onMouseDown={(event) => {
            event.preventDefault();
            runEditorCommand('insertUnorderedList');
          }}
          title="Bulleted list"
        >
          <List className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={cn(toolbarButtonClassName, toolbarState.orderedList && 'border-slate-300 bg-white text-slate-900')}
          onMouseDown={(event) => {
            event.preventDefault();
            runEditorCommand('insertOrderedList');
          }}
          title="Numbered list"
        >
          <ListOrdered className="h-4 w-4" />
        </Button>

        <div className="mx-1 h-6 w-px bg-slate-200" />

        <label className="flex h-8 items-center gap-2 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600 shadow-sm">
          <Type className="h-3.5 w-3.5" />
          <span>Text</span>
          <input
            type="color"
            value={toolbarState.textColor}
            onChange={(event) => runEditorCommand('foreColor', event.target.value)}
            className="h-5 w-5 cursor-pointer border-0 bg-transparent p-0"
            title="Text color"
          />
        </label>

        <label className="flex h-8 items-center gap-2 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600 shadow-sm">
          <Highlighter className="h-3.5 w-3.5" />
          <span>Highlight</span>
          <input
            type="color"
            value={toolbarState.highlightColor}
            onChange={(event) => runEditorCommand('hiliteColor', event.target.value)}
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
            runEditorCommand('undo');
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
            runEditorCommand('redo');
          }}
          title="Redo"
        >
          <Redo2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="bg-[linear-gradient(180deg,#ffffff_0%,#fbfdff_100%)] px-4 py-4">
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          spellCheck
          data-placeholder={placeholder}
          onInput={handleInput}
          onBlur={handleBlur}
          onFocus={() => {
            captureSelection();
            syncToolbarState();
          }}
          onKeyUp={() => {
            captureSelection();
            syncToolbarState();
          }}
          onMouseUp={() => {
            captureSelection();
            syncToolbarState();
          }}
          onPaste={handlePaste}
          className={cn(
            'rich-text-narrative-editor w-full rounded-xl border border-slate-200 bg-white px-6 py-5 text-[15px] leading-7 text-slate-800 shadow-[0_10px_30px_-20px_rgba(15,23,42,0.4)] outline-none transition focus-within:border-primary/40 focus-within:shadow-[0_12px_36px_-18px_rgba(37,99,235,0.3)]',
            minHeightClassName
          )}
        />
      </div>
    </div>
  );
}
