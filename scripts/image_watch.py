"""Read-only last-48-hour news-image watchdog; no model/API writes."""
import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / 'image-watch-state.json'


def safe_link(value):
    if not isinstance(value, str):
        return False
    try:
        u = urlparse(value)
        return u.scheme in ('https', 'http') and bool(u.hostname) and not u.username and not u.password
    except ValueError:
        return False


def valid_reason(value):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= 400


def esa_identity(value):
    # Mirror media/esa-image.ts; only exact same-image canonical renditions qualify.
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r'https://www\.esa\.int/var/esa/storage/images/(?:esa_multimedia/images/)?([0-9]{4})/(0[1-9]|1[0-2])/([a-z0-9]+(?:_[a-z0-9]+)*)/([0-9]+-[0-9]+-eng-GB)/([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*?)(?:_article|_pillars)?\.jpg', value)
    if not match or match[3] != match[5].lower():
        return None
    year, month, slug, version, name = match.groups()
    return (f'https://www.esa.int/ESA_Multimedia/Images/{year}/{month}/{name}',
            f'https://www.esa.int/var/esa/storage/images/esa_multimedia/images/{year}/{month}/{slug}/{version}/{name}.jpg')


def anomalies(rows):
    result = []
    for row in rows:
        if row.get('allowed') is not True:
            continue  # Deliberate copyright denial is not an operational failure.
        first = row.get('first')
        if first is None and 'media' in row:
            first = next((m for m in row['media'] or [] if m.get('kind') == 'image' and m.get('url')), None)
        review = row.get('review') or {}
        reasons = []
        if not first:
            reasons.append('未采集到候选图（不代表原文无图）')
        else:
            valid_rejection = review.get('status') == 'image-rejected' and review.get('approved') is False and review.get('category') in ('related', 'ad', 'logo', 'avatar', 'decorative', 'unrelated', 'uncertain') and valid_reason(review.get('reason')) and ('depiction' not in review or review['depiction'] in ('observation', 'artist_concept', 'diagram', 'uncertain')) and review.get('url') == first.get('url')
            if valid_rejection:
                continue
            rights_only = review.get('status') == 'rights-unverified' and review.get('suitabilityStatus') == 'approved' and review.get('category') == 'related'
            if not rights_only and (review.get('approved') is not True or review.get('category') != 'related'):
                reasons.append('审核未完成')
            if review.get('url') != first.get('url'):
                reasons.append('图片与审核记录不匹配')
            is_esa = row.get('source_name') == 'ESA Space Science' or bool(re.match(r'^https?://(?:www\.)?esa\.int/', row.get('url') or ''))
            if is_esa:
                identity = esa_identity(first.get('url'))
                if (review.get('status') != 'approved' and not rights_only) or not valid_reason(review.get('reason')):
                    if '审核未完成' not in reasons:
                        reasons.append('审核未完成')
                if not identity or ('canonicalUrl' in review and review['canonicalUrl'] != identity[1]):
                    reasons.append('图片与审核记录不匹配')
                if (review.get('rightsStatus') != 'verified' or
                    review.get('license') != 'ESA Standard Licence' or
                    review.get('licenseUrl') != 'https://www.esa.int/ESA_Multimedia/Terms_and_conditions_of_use_of_images_and_videos_available_on_the_esa_website'):
                    reasons.append('逐图许可未核实')
                credit = review.get('credit')
                if (not isinstance(credit, str) or not credit.strip() or len(credit) > 2000 or
                    not re.search(r'\bESA\b', credit) or not identity or review.get('attributionUrl') != identity[0]):
                    reasons.append('署名或图源缺失')
            elif review.get('rightsStatus') == 'unverified':
                reasons.append('逐图许可未核实')
            if row.get('requires_credit') is True and (not str(review.get('credit') or first.get('credit') or '').strip() or not safe_link(review.get('attributionUrl') or first.get('attributionUrl'))):
                reasons.append('署名或图源缺失')
        if reasons:
            result.append({'id': row['id'], 'title': row['title'], 'reasons': list(dict.fromkeys(reasons))})
    return sorted(result, key=lambda row: row['id'])


def changed_report(rows, previous):
    digest = hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    if digest == previous or not rows:
        return digest, ''
    lines = ['【小羊】近期新闻配图自动巡检发现待检查项（仅只读，不重跑模型）：']
    lines += ['- ' + r['title'] + '：' + '；'.join(r['reasons']) for r in rows]
    return digest, '\n'.join(lines)


NODE_QUERY = r"""const {sql}=await import('/app/packages/backend/src/db.ts');try{console.log(JSON.stringify(await sql`SELECT a.id,a.title,a.url,a.source_id,s.name AS source_name,a.media,n.output->'imageReview' AS review,s.config->'cardImageAllowed' AS allowed,s.config->'cardImageRequiresCredit' AS requires_credit FROM articles a JOIN publications p ON p.article_id=a.id JOIN sources s ON s.id=a.source_id LEFT JOIN analyses n ON n.id=p.analysis_id AND n.input_revision=p.revision WHERE p.channel='news' AND p.visibility='public' AND p.visible_after<=now() AND p.visible_after>=now()-interval '48 hours' ORDER BY a.id`));}finally{await sql.end();}"""


def collect(host):
    if not host or host.startswith('-'):
        raise ValueError('Explicit SSH host required')
    remote_code = 'import subprocess; r=subprocess.run(' + repr(['podman', 'exec', 'aihot_api_1', 'node', '--input-type=module', '-e', NODE_QUERY]) + ',capture_output=True,text=True,timeout=20); assert r.returncode==0; print(r.stdout)'
    r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=12', host, 'python3 -c ' + shlex.quote(remote_code)], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=35)
    if r.returncode:
        raise RuntimeError('SSH/data query failed')
    rows = json.loads(r.stdout)
    if not isinstance(rows, list):
        raise ValueError('Unexpected audit result')
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rows-file', type=Path)
    parser.add_argument('--ssh-host', help='Explicit previously trusted SSH target; no password prompts')
    parser.add_argument('--state-file', type=Path, default=STATE)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    state_file = args.state_file
    old = json.loads(state_file.read_text()) if state_file.exists() else {}
    try:
        rows = json.loads(args.rows_file.read_text()) if args.rows_file else collect(args.ssh_host)
        problems = anomalies(rows)
        digest, text = changed_report(problems, None if args.dry_run else old.get('digest'))
        state = {'digest': digest, 'articleCount': len(rows), 'problemCount': len(problems), 'problems': problems}
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        # Never print command arguments/env or assert that a failed query found no problems.
        digest = 'audit-failed:' + type(exc).__name__
        text = '' if old.get('digest') == digest else '【小羊】配图自动巡检未完成：连接或查询失败；尚未检查，未连续重试。'
        state = {'digest': digest, 'errorType': type(exc).__name__}
    if not args.dry_run:
        temp = state_file.with_suffix('.tmp')
        with temp.open('w') as f:
            os.chmod(temp, 0o600)
            json.dump(state, f, ensure_ascii=False, indent=2)
        temp.replace(state_file)
    if text:
        print(text)


if __name__ == '__main__':
    main()
