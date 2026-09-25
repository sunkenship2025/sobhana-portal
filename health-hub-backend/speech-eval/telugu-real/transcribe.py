"""REAL Telugu–English speech: 29 clips of 18 Telugu pharmacists and doctors on
YouTube naming a medicine and how to take it (manifest.json: video, window, the
drug, the schedule said — annotated from YouTube's own Telugu captions).

Fetches each window's audio, then hears it with Whisper large-v3 (the model the
dictation route asks Groq for), locally on Apple silicon via MLX, the way the
route does: temperature 0, the clinic's brand prompt, and for Telugu an 'en'
hearing plus a 'te' one. Audio and transcripts stay in .cache/ (not committed).

  python3 -m venv .venv && .venv/bin/pip install yt-dlp mlx-whisper
  (cd .. && npx tsx -e "...")   # writes .cache/asr-hint.txt — see check.ts
  .venv/bin/python3 transcribe.py en && .venv/bin/python3 transcribe.py te6

'te6' hears Telugu in 6 s pieces: the reference decoder stops at ~224 tokens per
30 s window and Telugu script needs ~2 a letter, so a long stretch lost its tail;
Groq returns 400+ tokens a clip, and the pieces emulate that.
"""
import json, os, subprocess, sys
import mlx_whisper

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.cache')
os.makedirs(CACHE, exist_ok=True)
man = json.load(open(os.path.join(HERE, 'manifest.json')))
lang = sys.argv[1] if len(sys.argv) > 1 else 'en'
chunk = int(lang[2:]) if lang[2:].isdigit() else 0
whisper_lang = lang[:2] if chunk else lang
out_path = os.path.join(CACHE, f'transcripts-{lang}.json')
out = json.load(open(out_path)) if os.path.exists(out_path) else {}
hint = open(os.path.join(CACHE, 'asr-hint.txt')).read()
ytdlp = os.path.join(os.path.dirname(sys.executable), 'yt-dlp')

for c in man:
    audio = os.path.join(CACHE, c['id'] + '.mp3')
    if not os.path.exists(audio):
        subprocess.run([ytdlp, '-q', '-f', 'bestaudio', '--download-sections', f"*{c['start']:.1f}-{c['end']:.1f}", '-x',
                        '--audio-format', 'mp3', '-o', os.path.join(CACHE, c['id'] + '.%(ext)s'),
                        f"https://www.youtube.com/watch?v={c['video']}"], check=False)
    if c['id'] in out or not os.path.exists(audio):
        continue
    dur = round(c['end'] - c['start'], 1)
    bounds = list(range(0, int(dur), chunk)) + [dur] if chunk else []
    extra = {'clip_timestamps': ','.join(f'{a},{b}' for a, b in zip(bounds, bounds[1:]))} if chunk else {}
    r = mlx_whisper.transcribe(audio, path_or_hf_repo='mlx-community/whisper-large-v3-mlx',
                               language=None if whisper_lang == 'auto' else whisper_lang,
                               initial_prompt=hint, temperature=0.0, **extra)
    out[c['id']] = {'text': r['text'].strip(), 'segments': [{'start': s['start'], 'end': s['end'], 'text': s['text']} for s in r['segments']]}
    json.dump(out, open(out_path, 'w'), ensure_ascii=False, indent=1)
    print(c['id'], '|', out[c['id']]['text'][:100], flush=True)
