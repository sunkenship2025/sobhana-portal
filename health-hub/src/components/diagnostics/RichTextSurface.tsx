import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  stripInlineFontSize,
} from '@/lib/richText';

export type ToolbarState = {
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

export const DEFAULT_TOOLBAR_STATE: ToolbarState = {
  bold: false,
  italic: false,
  underline: false,
  unorderedList: false,
  orderedList: false,
  alignment: 'left',
  block: 'p',
  fontFamily: NARRATIVE_FONT_FAMILIES[0],
  // Empty means "no explicit size override" — the toolbar renders this as `—`.
  fontSize: '',
  textColor: '#111827',
  highlightColor: '#fff59d',
};

export type RichTextSurfaceHandle = {
  runCommand: (command: string, value?: string) => void;
  focus: () => void;
};

interface RichTextSurfaceProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** className applied directly to the contentEditable element. Use for layout styling like `imaging-narrative`. */
  contentClassName?: string;
  onToolbarStateChange?: (state: ToolbarState) => void;
  onActiveChange?: (active: boolean) => void;
}

type CommandCapableDocument = Document & {
  execCommand?: (commandId: string, showUI?: boolean, value?: string) => boolean;
  queryCommandState?: (commandId: string) => boolean;
};

/**
 * Walk up from the selection toward (but not including) the editor root and
 * return the nearest ancestor that carries an explicit inline `font-size`.
 * Returns null when the text is simply inheriting the base size — that lets the
 * toolbar show `—` instead of snapping the inherited base to a misleading
 * number, so an accidental size override is visible rather than silent.
 */
function getExplicitFontSizeElement(
  startElement: HTMLElement | null,
  editor: HTMLElement
): HTMLElement | null {
  let element: HTMLElement | null = startElement;
  while (element && element !== editor && editor.contains(element)) {
    if (element.style?.fontSize) {
      return element;
    }
    element = element.parentElement;
  }
  return null;
}

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

export const RichTextSurface = forwardRef<RichTextSurfaceHandle, RichTextSurfaceProps>(function RichTextSurface(
  {
    value,
    onChange,
    placeholder = 'Start writing the narrative report...',
    className,
    contentClassName,
    onToolbarStateChange,
    onActiveChange,
  },
  ref
) {
  const editorRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const lastCommittedValueRef = useRef('');
  const isFocusedRef = useRef(false);

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

  const computeToolbarState = useCallback((): ToolbarState => {
    const editor = editorRef.current;
    if (!editor) return DEFAULT_TOOLBAR_STATE;

    const container = getSelectionContainer(editor);
    const block = container?.closest('h1, h2, h3, p')?.tagName.toLowerCase() as ToolbarState['block'] | null;
    const computedStyle = window.getComputedStyle(container || editor);
    const commandDocument = document as CommandCapableDocument;
    // Only report a size when the text actually carries an explicit override;
    // otherwise leave it blank so the toolbar shows `—` for inherited text.
    const explicitSizeElement = getExplicitFontSizeElement(container, editor);

    return {
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
      fontSize: explicitSizeElement
        ? getFontSizeLabelFromComputedSize(window.getComputedStyle(explicitSizeElement).fontSize)
        : '',
      textColor: normalizeColorForPicker(computedStyle.color),
      highlightColor: normalizeColorForPicker(container?.style.backgroundColor || '', '#fff59d'),
    };
  }, []);

  const syncToolbarState = useCallback(() => {
    if (!onToolbarStateChange) return;
    onToolbarStateChange(computeToolbarState());
  }, [computeToolbarState, onToolbarStateChange]);

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

  const clearFontSizeInSelection = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_ELEMENT);
    const targets: HTMLElement[] = [];

    let node = walker.nextNode();
    while (node) {
      const element = node as HTMLElement;
      if (element.style?.fontSize && range.intersectsNode(element)) {
        targets.push(element);
      }
      node = walker.nextNode();
    }

    targets.forEach((element) => {
      element.style.removeProperty('font-size');
      if (!element.getAttribute('style')) {
        element.removeAttribute('style');
      }
      // Unwrap spans that now carry nothing so we don't leave empty wrappers.
      if (element.tagName === 'SPAN' && element.attributes.length === 0) {
        const parent = element.parentNode;
        if (parent) {
          while (element.firstChild) {
            parent.insertBefore(element.firstChild, element);
          }
          parent.removeChild(element);
        }
      }
    });
  }, []);

  const runCommand = useCallback(
    (command: string, valueArg?: string) => {
      // Some commands need post-processing (font size override) — handle them here.
      if (command === 'fontSize') {
        // The `—` option sends an empty value: strip any explicit size so the
        // text falls back to the base, instead of applying a new override.
        if (!valueArg) {
          const editor = editorRef.current;
          if (!editor) return;
          editor.focus({ preventScroll: true });
          restoreSelection();
          clearFontSizeInSelection();
          captureSelection();
          commitEditorValue(editor.innerHTML, { normalize: false });
          syncToolbarState();
          return;
        }
        runEditorCommand('fontSize', valueArg, () => {
          const editor = editorRef.current;
          const sizePx = NARRATIVE_FONT_SIZE_OPTIONS.find((option) => option.value === valueArg)?.label;
          if (!editor || !sizePx) return;

          editor.querySelectorAll('font[size]').forEach((fontElement) => {
            const sizeValue = fontElement.getAttribute('size');
            if (sizeValue !== valueArg) {
              return;
            }

            const span = document.createElement('span');
            span.style.fontSize = `${sizePx}px`;
            span.innerHTML = fontElement.innerHTML;
            fontElement.replaceWith(span);
          });
        });
        return;
      }

      runEditorCommand(command, valueArg);
    },
    [
      captureSelection,
      clearFontSizeInSelection,
      commitEditorValue,
      restoreSelection,
      runEditorCommand,
      syncToolbarState,
    ]
  );

  useImperativeHandle(
    ref,
    () => ({
      runCommand,
      focus: () => editorRef.current?.focus({ preventScroll: true }),
    }),
    [runCommand]
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
    isFocusedRef.current = false;
    commitEditorValue(editor.innerHTML, { normalize: true, updateDom: true });
    syncToolbarState();
    onActiveChange?.(false);
  }, [commitEditorValue, onActiveChange, syncToolbarState]);

  const handleFocus = useCallback(() => {
    isFocusedRef.current = true;
    captureSelection();
    syncToolbarState();
    onActiveChange?.(true);
  }, [captureSelection, onActiveChange, syncToolbarState]);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();

      const html = event.clipboardData.getData('text/html');
      const text = event.clipboardData.getData('text/plain');
      // Strip font-size on paste so pasted text inherits the base size instead
      // of baking in a fixed size copied from the source (editor or Word),
      // which would make the findings body non-uniform.
      const pasteHtml = html
        ? stripInlineFontSize(sanitizeRichTextHtml(html))
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
    <div
      ref={editorRef}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      data-placeholder={placeholder}
      onInput={handleInput}
      onBlur={handleBlur}
      onFocus={handleFocus}
      onKeyUp={() => {
        captureSelection();
        syncToolbarState();
      }}
      onMouseUp={() => {
        captureSelection();
        syncToolbarState();
      }}
      onPaste={handlePaste}
      className={cn('rich-text-surface', contentClassName, className)}
    />
  );
});
