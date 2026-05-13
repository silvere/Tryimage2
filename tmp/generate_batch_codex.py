from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path('/Users/jingweisun/Code/Tryimage2')
PROMPT_TEMPLATE = (
    'Working directory: {repo}. '
    'Use built-in image generation exactly once. '
    'Generate this image: {prompt} '
    'After generating, copy the final image to {target}. '
    'Do not modify any other project files. '
    'In your final answer, print only the final copied path.'
)


def run_one(prompt: str, target: Path) -> None:
    command = [
        'codex', 'exec', '--full-auto', '-C', str(REPO),
        PROMPT_TEMPLATE.format(repo=REPO, prompt=prompt, target=target),
    ]
    attempts = 2
    for attempt in range(1, attempts + 1):
        try:
            result = subprocess.run(command, cwd=REPO, stdin=subprocess.DEVNULL, timeout=420)
        except subprocess.TimeoutExpired:
            if attempt == attempts:
                raise RuntimeError(f'codex timed out for {target.name}')
            print(f'[retry] {target.name} timeout on attempt {attempt}', flush=True)
            continue
        if result.returncode == 0 and target.exists() and target.stat().st_size > 0:
            return
        if attempt == attempts:
            raise RuntimeError(f'codex failed with exit code {result.returncode} for {target.name}')
        print(f'[retry] {target.name} exit={result.returncode} attempt={attempt}', flush=True)


def safe_name(value: str) -> str:
    text = str(value or '').strip().replace('/', '_').replace('\\', '_')
    return text or 'image.png'


def choose_target_name(item: dict, index: int, seen: set[str]) -> str:
    source = safe_name(item.get('source', ''))
    if source.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')) and source not in seen:
        seen.add(source)
        return source
    title = safe_name(item.get('title', f'item-{index:02d}'))
    if not title.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
        title = f'{index:02d}_{title}.png'
    elif not title[:3].isdigit():
        title = f'{index:02d}_{title}'
    candidate = title
    suffix = 2
    while candidate in seen:
        stem = Path(title).stem
        ext = Path(title).suffix or '.png'
        candidate = f'{stem}-{suffix}{ext}'
        suffix += 1
    seen.add(candidate)
    return candidate


def main() -> int:
    if len(sys.argv) != 2:
        print('usage: generate_batch_codex.py /absolute/path/to/batch.json', file=sys.stderr)
        return 2
    batch_path = Path(sys.argv[1]).resolve()
    metadata = json.loads(batch_path.read_text())
    batch_id = metadata['batchId']
    out_dir = REPO / 'tmp' / batch_id
    out_dir.mkdir(parents=True, exist_ok=True)
    items = metadata['items']
    print(f'[batch] {batch_id} items={len(items)}', flush=True)
    seen: set[str] = set()
    for index, item in enumerate(items, start=1):
        target = out_dir / choose_target_name(item, index, seen)
        if target.exists() and target.is_file() and target.stat().st_size > 0:
            print(f'[skip] {batch_id} {index:02d} {target.name}', flush=True)
            continue
        print(f'[start] {batch_id} {index:02d} {target.name}', flush=True)
        try:
            run_one(item['prompt'], target)
        except Exception as exc:
            print(f'[error] {batch_id} {index:02d} {target.name}: {exc}', flush=True)
            return 1
        print(f'[done] {batch_id} {index:02d} {target.name}', flush=True)
    print(f'[all-done] {batch_id}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
