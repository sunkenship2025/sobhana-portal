/**
 * Readable slugs for waiting-room display URLs, e.g. /display/chintal/op.
 * The branch slug is derived from the branch name ("Sobhana - Chintal" →
 * "chintal"); each screen carries its own slug (unique within the branch).
 */
export function slugify(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Branch slug: name minus a leading "sobhana", else the code. */
export function branchSlug(name: string, code: string): string {
  const s = slugify(name).replace(/^sobhana-?/, '');
  return s || slugify(code) || (code || '').toLowerCase();
}
