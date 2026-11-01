// scripts/dsh-superagent（POSIX Python 脚本）的场景化自动化测试。
// 原有验证方式是临时 python heredoc：用 importlib SourceFileLoader 加载脚本模块后直调函数。
// 本文件把 8 类场景固化：场景断言放 python 侧（print PASS + 断言），ts 侧只断言 exit code 与 PASS 标记。

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

const SCRIPT = join(__dirname, '..', 'scripts', 'dsh-superagent');

/** 场景骨架：把模块加载 + 临时目录重定向（ROOT/ARTIFACTS/CONTROL/DSH_HOME）准备好后执行 scenario(body)。 */
const RUNNER = `
import importlib.machinery
import importlib.util
import json
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ARTIFACTS = ROOT / 'artifacts'
CONTROL = ARTIFACTS / 'control'
DSH_HOME = ROOT / 'dsh-home'

loader = importlib.machinery.SourceFileLoader('dsh_superagent_under_test', {SCRIPT!r})
spec = importlib.util.spec_from_loader(loader.name, loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)

# 重定向模块级常量，避免测试触碰真实仓库的 .artifacts 与用户 DSH_HOME。
mod.ROOT = ROOT
mod.ARTIFACTS = ARTIFACTS
mod.CONTROL = CONTROL

os.environ['DSH_HOME'] = str(DSH_HOME)
CONTROL.mkdir(parents=True, exist_ok=True)
DSH_HOME.mkdir(parents=True, exist_ok=True)

PROFILE = 'testprofile'


def profile_home():
    return DSH_HOME / 'profiles' / PROFILE


def ok(message=''):
    if message:
        print(message)
    print('PASS')
    sys.exit(0)


def fail(message):
    print('FAIL: ' + message)
    sys.exit(1)


def run(body):
    # 传 globals() 让场景内定义的嵌套函数（如 TOCTOU 的 racing_stat）按全局名解析场景变量。
    exec(body, globals())


run('''''')`;

interface Scenario {
  name: string;
  /** 场景 python 代码，失败时 sys.exit(1)，成功时 ok()。 */
  body: string;
}

function runScenario(scenario: Scenario): { status: number; output: string } {
  // 场景临时目录放在仓库 .artifacts 下：本会话沙箱对 /tmp 的跨进程写入不可靠。
  const baseDir = join(__dirname, '..', '.artifacts', 'test-tmp');
  mkdirSync(baseDir, { recursive: true });
  const dir = mkdtempSync(join(baseDir, 'scenario-'));
  try {
    const runner = RUNNER.replace('{SCRIPT!r}', JSON.stringify(SCRIPT)).replace(
      "run('''''')",
      `run('''${scenario.body}''')`,
    );
    const scriptPath = join(dir, 'scenario.py');
    writeFileSync(scriptPath, runner);
    const result = spawnSync('python3', [scriptPath], { encoding: 'utf8', timeout: 60_000 });
    return { status: result.status ?? -1, output: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectPass(scenario: Scenario): void {
  const { status, output } = runScenario(scenario);
  if (status !== 0 || !output.includes('PASS')) {
    throw new Error(`场景 ${scenario.name} 失败 (exit=${status})：\n${output}`);
  }
}

describePosix('scripts/dsh-superagent', () => {
  const scenarios: Scenario[] = [
    {
      name: 'service_url：flag > url.txt > 日志 > 默认 的四级解析链',
      body: `
import types
from pathlib import Path

def make_args(url=None):
    return types.SimpleNamespace(url=url, profile=PROFILE)

# 第 4 级：什么都没有 -> 默认地址
assert mod.service_url(make_args()) == mod.DEFAULT_URL

# 第 3 级：日志里的 'dsh web: URL'（新日志优先，token 后缀剥掉）
name = 'dsh-superagent-' + PROFILE + '-20260101-000000-1.log'
(ARTIFACTS / (name)).write_text('boot ok' + chr(10) + 'dsh web: http://127.0.0.1:4321/?token=abc' + chr(10), encoding='utf-8')
assert mod.service_url(make_args()) == 'http://127.0.0.1:4321', '应从日志解析并剥 token'

# 第 2 级：url.txt 存在时压过日志
recorded = 'http://127.0.0.1:5000/'
(CONTROL / 'profiles' / PROFILE / 'url.txt').write_text(recorded + chr(10), encoding='utf-8')
assert mod.service_url(make_args()) == 'http://127.0.0.1:5000', 'url.txt 应压过日志'

# 第 1 级：--url flag 压过一切，且做 sanitize
assert mod.service_url(make_args('http://127.0.0.1:6000/?token=xyz///')) == 'http://127.0.0.1:6000'
ok('四级解析链正确'),
`,
    },
    {
      name: 'sanitize：剥 /?token=... 与尾斜杠（flag 与 url.txt 两路）',
      body: `
import types

# url.txt 一路：token 与尾斜杠都被剥掉
(CONTROL / 'profiles' / PROFILE).mkdir(parents=True, exist_ok=True)
(CONTROL / 'profiles' / PROFILE / 'url.txt').write_text('http://127.0.0.1:7000/?token=secret/', encoding='utf-8')
args = types.SimpleNamespace(url=None, profile=PROFILE)
assert mod.service_url(args) == 'http://127.0.0.1:7000', 'url.txt 路径应剥 token'

# flag 一路
assert mod.sanitize('http://h/?token=t') == 'http://h'
assert mod.sanitize('http://h///') == 'http://h'
assert mod.sanitize('http://h') == 'http://h'
ok('两路 token 剥离正确'),
`,
    },
    {
      name: 'configured_state_dir：注释行跳过 / 行内注释剥离 / 多条目取最后 / 缺失返回 None',
      body: `
home = profile_home()
home.mkdir(parents=True, exist_ok=True)

# 缺失：文件不存在
home.joinpath('cordis.patch.yml').unlink(missing_ok=True)
assert mod.configured_state_dir(PROFILE) is None, '文件缺失应返回 None'

patch = home / 'cordis.patch.yml'
patch.write_text(
    '# stateDir: /commented/first' + chr(10)
    + 'stateDir: "/real/one"  # 行内备注' + chr(10)
    + '  stateDir: /indented/two' + chr(10)
    + '# stateDir: /commented/last' + chr(10),
    encoding='utf-8',
)
found = mod.configured_state_dir(PROFILE)
assert found is not None and str(found) == '/indented/two', f'应取最后一个真实条目，得到 {found}'

patch.write_text('stateDir: "/quoted/path" # note' + chr(10), encoding='utf-8')
assert str(mod.configured_state_dir(PROFILE)) == '/quoted/path', '应去引号并剥行内注释'
ok('stateDir 解析正确'),
`,
    },
    {
      name: 'wait_for_state_lock：stateDir 缺失 -> 立即返回',
      body: `
home = profile_home()
home.mkdir(parents=True, exist_ok=True)
home.joinpath('cordis.patch.yml').unlink(missing_ok=True)
assert mod.state_lock(PROFILE) is None
mod.wait_for_state_lock(PROFILE, timeout=1)  # 不应抛错
ok(),
`,
    },
    {
      name: 'wait_for_state_lock：无锁目录 -> 立即返回',
      body: `
home = profile_home()
home.mkdir(parents=True, exist_ok=True)
(home / 'cordis.patch.yml').write_text('stateDir: ' + str(ROOT / 'state') + chr(10), encoding='utf-8')
assert mod.state_lock(PROFILE) is not None and not mod.state_lock(PROFILE).exists()
mod.wait_for_state_lock(PROFILE, timeout=1)
ok(),
`,
    },
    {
      name: 'wait_for_state_lock：新鲜锁超时 -> RuntimeError',
      body: `
home = profile_home()
home.mkdir(parents=True, exist_ok=True)
state = ROOT / 'state'
(home / 'cordis.patch.yml').write_text('stateDir: ' + str(state) + chr(10), encoding='utf-8')
lock = Path(str(state) + '.lock')
lock.mkdir(parents=True)
try:
    mod.wait_for_state_lock(PROFILE, timeout=1)
    fail('新鲜锁应超时抛 RuntimeError')
except RuntimeError as error:
    assert 'still locked' in str(error), str(error)
ok('新鲜锁超时分支正确'),
`,
    },
    {
      name: 'wait_for_state_lock：陈旧锁（mtime 超过 LOCK_STALE）-> 立即返回',
      body: `
home = profile_home()
home.mkdir(parents=True, exist_ok=True)
state = ROOT / 'state'
(home / 'cordis.patch.yml').write_text('stateDir: ' + str(state) + chr(10), encoding='utf-8')
lock = Path(str(state) + '.lock')
lock.mkdir(parents=True)
old = time.time() - mod.LOCK_STALE - 5
os.utime(lock, (old, old))
mod.wait_for_state_lock(PROFILE, timeout=1)  # 不应等待也不应抛错
ok('陈旧锁分支正确'),
`,
    },
    {
      name: 'wait_for_state_lock：TOCTOU（exists 后 stat 前锁被删）-> 视为已释放',
      body: `
home = profile_home()
home.mkdir(parents=True, exist_ok=True)
state = ROOT / 'state'
(home / 'cordis.patch.yml').write_text('stateDir: ' + str(state) + chr(10), encoding='utf-8')
lock = Path(str(state) + '.lock')
lock.mkdir(parents=True)

# 模拟审查发现 #1 的竞态：exists() 为真，但在 stat() 时锁目录已被删除。
real_stat = Path.stat
deleted = {'hit': False}

def racing_stat(self, *args, **kwargs):
    if self == lock and not deleted['hit']:
        deleted['hit'] = True
        shutil.rmtree(lock)
        raise FileNotFoundError(str(lock))
    return real_stat(self, *args, **kwargs)

Path.stat = racing_stat
try:
    mod.wait_for_state_lock(PROFILE, timeout=2)  # 不应抛错、不应等满 timeout
finally:
    Path.stat = real_stat
assert deleted['hit'], '竞态注入未生效'
ok('TOCTOU 分支正确'),
`,
    },
  ];

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      expectPass(scenario);
    });
  }
});
