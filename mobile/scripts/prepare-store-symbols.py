#!/usr/bin/env python3
"""补齐归档中 UUID 匹配的官方 dSYM；缺失时失败，禁止继续上传。"""
import argparse
from pathlib import Path
import plistlib
import re
import shutil
import subprocess


def uuids(binary):
    output = subprocess.check_output(
        ['xcrun', 'dwarfdump', '--uuid', str(binary)], text=True)
    result = set(re.findall(r'UUID: ([0-9A-F-]+) \(([^)]+)\)', output))
    if not result:
        raise ValueError(f'没有可核验的 UUID：{binary}')
    return result


def prepare(archive, source=None):
    apps = list((archive / 'Products/Applications').glob('*.app'))
    if len(apps) != 1:
        raise ValueError('归档必须包含一个主应用')
    app = apps[0]
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    binaries = [app / info['CFBundleExecutable']]
    binaries += [f / f.stem for f in app.rglob('*.framework')]
    binaries += list(app.rglob('*.dylib'))
    for extension in app.rglob('*.appex'):
        metadata = plistlib.loads((extension / 'Info.plist').read_bytes())
        binaries.append(extension / metadata['CFBundleExecutable'])
    destination = archive / 'dSYMs'
    destination.mkdir(exist_ok=True)
    candidates = list(destination.glob('*.dSYM'))
    if source:
        candidates += list(source.rglob('*.dSYM'))
    indexed = [(p, uuids(p)) for p in candidates]
    missing = []
    for binary in binaries:
        needed = uuids(binary)
        match = next((p for p, ids in indexed if needed <= ids), None)
        if match is None:
            missing.append(f'{binary.name}: {sorted(needed)}')
            continue
        target = destination / match.name
        if match.resolve() != target.resolve():
            if target.exists():
                raise ValueError(f'已有同名但不匹配的符号，拒绝覆盖：{target}')
            shutil.copytree(match, target)
        if not needed <= uuids(target):
            raise ValueError(f'复制后的符号不匹配：{target}')
        print(f'匹配：{binary.name}')
    if missing:
        raise ValueError('禁止上传，缺少符号：\n' + '\n'.join(missing))
    print(f'通过：{len(binaries)} 个二进制均有匹配符号')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--source', type=Path, help='已解压的官方符号目录；省略则只检查')
    args = parser.parse_args()
    prepare(args.archive, args.source)
