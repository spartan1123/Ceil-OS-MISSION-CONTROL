#!/usr/bin/env python3
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/root/.openclaw')
ENV_PATH = ROOT / '.env'
CONFIG_PATH = ROOT / 'web-search-fallback.json'
STATE_PATH = ROOT / 'web-search-fallback-state.json'

DEFAULT_CONFIG = {
    'providerOrder': ['brave', 'tavily', 'serper', 'serpapi'],
    'monthlyCapsUsd': {
        'brave': 5.0,
        'tavily': 0.0,
        'serper': 0.0,
        'serpapi': 0.0,
    },
    'notes': {
        'brave': 'Use free monthly credit only; do not exceed configured cap.',
        'tavily': 'Free-tier only. If billing would be required, disable or record spend to block further use.',
        'serper': 'Free-tier only. If billing would be required, disable or record spend to block further use.',
        'serpapi': 'Free-tier only. If billing would be required, disable or record spend to block further use.',
    },
}


def now_month():
    return datetime.now(timezone.utc).strftime('%Y-%m')


def load_dotenv(path: Path):
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip()
        if value.startswith(('"', "'")) and value.endswith(('"', "'")) and len(value) >= 2:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def ensure_json(path: Path, default_obj):
    if not path.exists():
        path.write_text(json.dumps(default_obj, indent=2) + '\n')
        os.chmod(path, 0o600)
        return default_obj
    with path.open() as f:
        return json.load(f)


def save_json(path: Path, obj):
    path.write_text(json.dumps(obj, indent=2) + '\n')
    os.chmod(path, 0o600)


def get_state():
    return ensure_json(STATE_PATH, {'month': now_month(), 'spentUsd': {}, 'lastUsed': {}})


def reset_state_if_needed(state):
    month = now_month()
    if state.get('month') != month:
        state['month'] = month
        state['spentUsd'] = {}
        state['lastUsed'] = {}


def can_use_provider(provider, config, state):
    caps = config.get('monthlyCapsUsd', {})
    cap = float(caps.get(provider, 0.0))
    spent = float(state.get('spentUsd', {}).get(provider, 0.0))
    return spent < cap or (cap == 0.0 and spent == 0.0)


def provider_error(provider, message):
    return {'provider': provider, 'error': message}


def http_json(url, *, headers=None, method='GET', body=None):
    req = urllib.request.Request(url, headers=headers or {}, method=method)
    if body is not None:
        body = json.dumps(body).encode('utf-8')
        req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, data=body, timeout=30) as resp:
        charset = resp.headers.get_content_charset() or 'utf-8'
        text = resp.read().decode(charset)
        return json.loads(text)


def brave_search(query, count=5, country='US', language='en', freshness=None):
    key = os.environ.get('BRAVE_API_KEY')
    if not key:
        raise RuntimeError('BRAVE_API_KEY missing')
    params = {
        'q': query,
        'count': count,
        'country': country,
        'search_lang': language,
    }
    if freshness:
        params['freshness'] = freshness
    url = 'https://api.search.brave.com/res/v1/web/search?' + urllib.parse.urlencode(params)
    data = http_json(url, headers={'Accept': 'application/json', 'X-Subscription-Token': key})
    results = []
    for item in data.get('web', {}).get('results', []):
        results.append({
            'title': item.get('title'),
            'url': item.get('url'),
            'description': item.get('description') or item.get('snippet'),
            'provider': 'brave',
        })
    return {'provider': 'brave', 'results': results}


def tavily_search(query, count=5):
    key = os.environ.get('TAVILY_API_KEY')
    if not key:
        raise RuntimeError('TAVILY_API_KEY missing')
    body = {
        'api_key': key,
        'query': query,
        'max_results': count,
        'search_depth': 'basic',
        'include_answer': False,
        'include_raw_content': False,
    }
    data = http_json('https://api.tavily.com/search', method='POST', body=body)
    results = []
    for item in data.get('results', []):
        results.append({
            'title': item.get('title'),
            'url': item.get('url'),
            'description': item.get('content'),
            'provider': 'tavily',
        })
    return {'provider': 'tavily', 'results': results}


def serper_search(query, count=5, country='us', language='en'):
    key = os.environ.get('SERPER_API_KEY')
    if not key:
        raise RuntimeError('SERPER_API_KEY missing')
    body = {'q': query, 'num': count, 'gl': country.lower(), 'hl': language}
    data = http_json('https://google.serper.dev/search', method='POST', headers={'X-API-KEY': key}, body=body)
    results = []
    for item in data.get('organic', []):
        results.append({
            'title': item.get('title'),
            'url': item.get('link'),
            'description': item.get('snippet'),
            'provider': 'serper',
        })
    return {'provider': 'serper', 'results': results}


def serpapi_search(query, count=5, country='us', language='en'):
    key = os.environ.get('SERPAPI_API_KEY')
    if not key:
        raise RuntimeError('SERPAPI_API_KEY missing')
    params = {
        'engine': 'google',
        'q': query,
        'num': count,
        'gl': country.lower(),
        'hl': language,
        'api_key': key,
        'output': 'json',
    }
    url = 'https://serpapi.com/search?' + urllib.parse.urlencode(params)
    data = http_json(url)
    results = []
    for item in data.get('organic_results', []):
        results.append({
            'title': item.get('title'),
            'url': item.get('link'),
            'description': item.get('snippet'),
            'provider': 'serpapi',
        })
    return {'provider': 'serpapi', 'results': results}


SEARCHERS = {
    'brave': brave_search,
    'tavily': tavily_search,
    'serper': serper_search,
    'serpapi': serpapi_search,
}


def do_search(args):
    load_dotenv(ENV_PATH)
    config = ensure_json(CONFIG_PATH, DEFAULT_CONFIG)
    state = get_state()
    reset_state_if_needed(state)
    providers = [args.provider] if args.provider else config.get('providerOrder', DEFAULT_CONFIG['providerOrder'])
    failures = []
    for provider in providers:
        if provider not in SEARCHERS:
            failures.append(provider_error(provider, 'unknown provider'))
            continue
        if not can_use_provider(provider, config, state):
            failures.append(provider_error(provider, 'monthly cap reached according to local ledger'))
            continue
        try:
            if provider in ('brave', 'serper', 'serpapi'):
                payload = SEARCHERS[provider](args.query, count=args.count, country=args.country, language=args.language)
            else:
                payload = SEARCHERS[provider](args.query, count=args.count)
            state.setdefault('lastUsed', {})[provider] = datetime.now(timezone.utc).isoformat()
            save_json(STATE_PATH, state)
            payload['query'] = args.query
            payload['fallbackChain'] = providers
            payload['failures'] = failures
            print(json.dumps(payload, indent=2))
            return 0
        except Exception as e:
            failures.append(provider_error(provider, str(e)))
    print(json.dumps({'query': args.query, 'results': [], 'failures': failures, 'fallbackChain': providers}, indent=2))
    return 2


def do_status(_args):
    config = ensure_json(CONFIG_PATH, DEFAULT_CONFIG)
    state = get_state()
    reset_state_if_needed(state)
    out = {
        'month': state.get('month'),
        'providerOrder': config.get('providerOrder'),
        'monthlyCapsUsd': config.get('monthlyCapsUsd'),
        'spentUsd': state.get('spentUsd', {}),
        'lastUsed': state.get('lastUsed', {}),
        'notes': config.get('notes', {}),
    }
    print(json.dumps(out, indent=2))
    save_json(STATE_PATH, state)
    return 0


def do_record_spend(args):
    state = get_state()
    reset_state_if_needed(state)
    state.setdefault('spentUsd', {})
    state['spentUsd'][args.provider] = round(float(state['spentUsd'].get(args.provider, 0.0)) + args.usd, 6)
    save_json(STATE_PATH, state)
    print(json.dumps({'ok': True, 'provider': args.provider, 'spentUsd': state['spentUsd'][args.provider], 'month': state['month']}, indent=2))
    return 0


def build_parser():
    p = argparse.ArgumentParser(description='Local multi-provider web search fallback wrapper for OpenClaw.')
    sub = p.add_subparsers(dest='cmd', required=True)

    s = sub.add_parser('search', help='Run search with provider fallback')
    s.add_argument('query')
    s.add_argument('--count', type=int, default=5)
    s.add_argument('--country', default='US')
    s.add_argument('--language', default='en')
    s.add_argument('--provider', choices=sorted(SEARCHERS.keys()))
    s.set_defaults(func=do_search)

    st = sub.add_parser('status', help='Show provider order, caps, and local spend ledger')
    st.set_defaults(func=do_status)

    rs = sub.add_parser('record-spend', help='Manually record spend against a provider in the local ledger')
    rs.add_argument('provider', choices=sorted(SEARCHERS.keys()))
    rs.add_argument('usd', type=float)
    rs.set_defaults(func=do_record_spend)
    return p


def main():
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main())
