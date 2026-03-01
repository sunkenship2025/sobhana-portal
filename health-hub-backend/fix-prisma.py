import os
import re

BASE = '/Users/pranavreddy/Desktop/sobhana portal/health-hub-backend'

# Files to process (excluding lib/prisma.ts itself)
targets = []
for root, dirs, files in os.walk(os.path.join(BASE, 'src')):
    for f in files:
        if f.endswith('.ts') and f != 'prisma.ts':
            full = os.path.join(root, f)
            with open(full) as fh:
                content = fh.read()
            if 'new PrismaClient()' in content:
                targets.append(full)

for path in sorted(targets):
    with open(path) as fh:
        content = fh.read()

    # Determine relative path to lib/prisma
    # Normalize to relative path from BASE
    rel_path = os.path.relpath(path, BASE).replace('\\', '/')
    parts = rel_path.split('/')
    # parts[0] == 'src', parts[-1] == filename
    # levels_below_src = number of directories between src and the file
    levels_below_src = len(parts) - 2  # subtract 'src' and filename

    if levels_below_src == 0:
        rel_import = './lib/prisma'
    else:
        rel_import = '../' * levels_below_src + 'lib/prisma'

    new_import = f"import prisma from '{rel_import}';"

    # Skip if already has this import
    if new_import in content:
        print(f"Already fixed: {path}")
        continue

    # Remove the PrismaClient import line
    content = re.sub(r"import \{ PrismaClient \} from '@prisma/client';\n", '', content)
    # Remove the const prisma = new PrismaClient(); line
    content = re.sub(r"const prisma = new PrismaClient\(\);\n", '', content)

    # Insert new import after the last top-level import line
    lines = content.split('\n')
    last_import_idx = -1
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('import ') and f"'{rel_import}'" not in stripped:
            last_import_idx = i

    if last_import_idx >= 0:
        lines.insert(last_import_idx + 1, new_import)
        content = '\n'.join(lines)
    else:
        content = new_import + '\n' + content

    with open(path, 'w') as fh:
        fh.write(content)

    print(f"Fixed: {path} (import: {rel_import})")

print(f"\nTotal: {len(targets)} files processed")
