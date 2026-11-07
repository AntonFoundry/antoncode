"""Project automatic quota failover through the real Python SDK."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
FIXTURE = ROOT / 'snapshots' / 'session' / 'model-failover-quota'


@pytest.mark.skipif(not CLI.exists(), reason='requires the built dsh profile runtime')
def test_model_failover_quota_snapshot(tmp_path: Path) -> None:
    rows = [json.loads(line) for line in (FIXTURE / 'session.v4.jsonl').read_text().splitlines()]
    task = next(row['data']['content'][0]['text'] for row in rows
                if row['type'] == 'user/message' and row['data']['source']['kind'] == 'user')
    packages = tmp_path / 'home' / 'profiles' / 'sdk' / 'node_modules' / '@deepseek-ai'
    packages.mkdir(parents=True)
    for package, source in (
        ('dsh-llm-replay', 'packages/test-support/llm-replay'),
        ('dsh-hooks-claude-code', 'packages/experimental/hooks-claude-code'),
        ('dsh-hooks-codex', 'packages/experimental/hooks-codex'),
    ):
        (packages / package).symlink_to(ROOT / source, target_is_directory=True)
    with DeepSeekHarness(
        dsh_bin=str(CLI),
        dsh_home=str(tmp_path / 'home'),
        cwd=str(tmp_path),
        profile='sdk',
        patches=(
            str(ROOT / 'snapshots' / 'session' / 'text-turn' / 'cordis.yml'),
            str(FIXTURE / 'cordis.snapshot.yml'),
        ),
        provider='deepseek-official',
        model='deepseek-v4-flash',
        env={
            'DSH_TELEMETRY_DISABLED': '1',
            'DSH_SNAPSHOT': 'replay',
            'DSH_SNAPSHOT_FILE': str(FIXTURE / 'session.v4.jsonl'),
            'DSH_SNAPSHOT_OVERRIDE': str(FIXTURE / 'replay.override.json'),
            'DSH_PERMISSION_MODE': 'danger-full-access',
            'DEEPSEEK_API_KEY': '',
        },
    ) as harness:
        result = harness.run(task)
    events = result.events
    attempts = [event['data']['attempt'] for event in events if event['type'] == 'llm/failover-attempt']
    switches = [{key: event['data'][key] for key in ('primary', 'from', 'to', 'reason', 'failureCode')}
                for event in events if event['type'] == 'llm/failover']
    notices = [event['data']['content'][0]['text'] for event in events
               if event['type'] == 'user/message' and event['data']['source']['kind'] == 'model-failover']
    actual = {
        'final_response': result.final_response,
        'finish_reason': result.finish_reason,
        'attempts': attempts,
        'switches': switches,
        'notices': notices,
        'assistant_sources': [event['data']['message']['source'] for event in events
                              if event['type'] == 'assistant/message'],
        'manual_selections': [event['data'] for event in events if event['type'] == 'model/selection'],
    }
    expected = Path(__file__).with_name('expected') / 'model-failover-quota.json'
    assert actual == json.loads(expected.read_text())
