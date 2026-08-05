#!/usr/bin/env python3
"""
HealthFlow cold-email sender (Hyderabad diagnostic centres).
Sends from saipranav.earning@gmail.com via macOS Mail.app. No attachment (text-only for deliverability).

  python3 cold_mailer.py generate     # build batch_all.json from email-ready.csv (dedupe + prune + personalize)
  python3 cold_mailer.py dry           # print what WOULD send (not-yet-sent), no sending
  python3 cold_mailer.py send --limit 20   # actually send up to 20 not-yet-sent, spaced out
"""
import os, re, csv, json, sys, subprocess, time

HERE = os.path.dirname(os.path.abspath(__file__))
CSV = os.path.join(HERE, "email-ready.csv")
BATCH = os.path.join(HERE, "batch_all.json")
SENT_LOG = os.path.join(HERE, "_email_sent.log")
SENDER = "pranav@healthflow.in"

# workflow-flagged bad fits (multi-city chains / already software-mature) -> skip
EXCLUDE = ["likhitha", "apple diagnostic", "aquats", "dr remedies"]

def clean_center(name):
    return re.sub(r"\s*\(.*?\)\s*", " ", name).strip().rstrip(",").strip()

def greeting(owner, center, email):
    o = (owner or "").split("(")[0].strip()
    if o.lower().startswith("dr"):
        surname = re.sub(r"^dr\.?\s*", "", o, flags=re.I).strip().split()
        surname = [w for w in surname if len(w) > 1]  # drop initials
        if surname:
            return f"Dear Dr. {surname[-1]},"
    return f"Hello {clean_center(center)} team,"

def build_email(row):
    center = clean_center(row["name"])
    subject = "Built this after watching my father run a diagnostic centre"
    body = (
        f"{greeting(row['owner'], center, row['email'])}\n\n"
        f"My father runs a diagnostic centre here in Hyderabad. For years I watched him stay back "
        f"late over paper registers, writing reports by hand and chasing patients to collect them. "
        f"So I built HealthFlow to fix exactly that, for centres like {center}.\n\n"
        f"HealthFlow runs your billing and your lab reports, with age and gender reference ranges "
        f"built in, then sends the bill and the report to the patient on WhatsApp automatically. "
        f"All under your own name and letterhead, with a QR the patient can scan to verify. It is "
        f"the system I wish my father had.\n\n"
        f"It starts at just 399 rupees a month. Most centres are quoted 8,000 or more for something "
        f"similar. I am giving the first centres a 15 day free trial, no card and no setup fee, "
        f"because I would rather earn your trust than your setup fee.\n\n"
        f"You can see the whole thing at healthflow.in. Could I show you a 2 minute demo this week, "
        f"or set it up on your own data so you can try it live?\n\n"
        f"Thanks,\n"
        f"Saipranav\n"
        f"HealthFlow, Hyderabad\n"
        f"healthflow.in\n"
        f"pranav@healthflow.in\n"
        f"+91 63094 14582"
    )
    return {"name": center, "to": row["email"].strip(), "subject": subject, "body": body}

def generate():
    rows = list(csv.DictReader(open(CSV)))
    seen_email, out, skipped = set(), [], []
    for r in rows:
        em = r["email"].strip().lower()
        if not em or "@" not in em:
            continue
        if any(x in r["name"].lower() for x in EXCLUDE):
            skipped.append((r["name"], "flagged chain/already-software")); continue
        if em in seen_email:
            skipped.append((r["name"], "duplicate email")); continue
        seen_email.add(em)
        out.append(build_email(r))
    json.dump(out, open(BATCH, "w"), indent=2)
    print(f"generated {len(out)} unique personalized emails -> batch_all.json")
    print(f"skipped {len(skipped)}:")
    for n, why in skipped:
        print(f"   - {n[:45]}: {why}")

def already_sent():
    if not os.path.exists(SENT_LOG):
        return set()
    return set(l.split("\t")[0].strip().lower() for l in open(SENT_LOG))

def esc(s):
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", '" & return & "')

def send_one(e):
    script = f'''
    tell application "Mail"
        set m to make new outgoing message with properties {{visible:false}}
        tell m
            set sender to "{SENDER}"
            set subject to "{esc(e['subject'])}"
            set content to "{esc(e['body'])}" & return
            make new to recipient at end of to recipients with properties {{address:"{e['to']}"}}
        end tell
        delay 1
        send m
    end tell
    '''
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=60)
        return (r.returncode == 0), (r.stderr.strip() or "sent")
    except Exception as ex:
        return False, str(ex)

def preview(e, to="saipranav.me@gmail.com"):
    """Open a VISIBLE draft in Mail.app (does NOT send) so the copy can be reviewed."""
    script = f'''
    tell application "Mail"
        activate
        set m to make new outgoing message with properties {{visible:true}}
        tell m
            set sender to "{SENDER}"
            set subject to "[PREVIEW] {esc(e['subject'])}"
            set content to "{esc(e['body'])}" & return
            make new to recipient at end of to recipients with properties {{address:"{to}"}}
        end tell
    end tell
    '''
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=60)
    return (r.returncode == 0), (r.stderr.strip() or "opened draft")

def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("generate", "dry", "send", "preview"):
        print(__doc__); return
    if sys.argv[1] == "preview":
        emails = json.load(open(BATCH))
        idx = 1 if len(emails) > 1 else 0  # a doctor-greeting sample
        ok, msg = preview(emails[idx])
        print(f"preview -> {msg}: {emails[idx]['subject']}")
        return
    mode = sys.argv[1]
    if mode == "generate":
        return generate()
    emails = json.load(open(BATCH))
    sent = already_sent()
    pending = [e for e in emails if e["to"].lower() not in sent]
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    if limit:
        pending = pending[:limit]
    print(f"{len(emails)} total, {len(sent)} already sent, sending {len(pending)} now (mode={mode.upper()})")
    print(f"FROM: {SENDER}\n" + "-" * 60)
    ok = 0
    for i, e in enumerate(pending, 1):
        print(f"[{i}/{len(pending)}] -> {e['to']}  |  {e['subject']}")
        if mode == "dry":
            continue
        s, msg = send_one(e)
        print(f"     {'OK' if s else 'FAIL'}: {msg}")
        if s:
            ok += 1
            open(SENT_LOG, "a").write(f"{e['to']}\t{e['name']}\t{e['subject']}\n")
            time.sleep(12)  # space sends to protect the gmail account
    if mode == "send":
        print("-" * 60 + f"\nDONE: {ok}/{len(pending)} sent")

if __name__ == "__main__":
    main()
