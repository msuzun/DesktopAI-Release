"""Explicit acquisition; inference never imports or invokes this module."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import time
import urllib.request


def digest(path, entry):
    algorithm = 'sha256' if entry.get('sha256') else 'sha1'
    result = hashlib.new(algorithm)
    if algorithm == 'sha1':
        result.update(f"blob {entry['size']}\0".encode())
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest() == entry.get('sha256', entry.get('gitBlob'))


def install_visual_adapter(destination, checkpoint, lock):
    """Acquire the bundled, pinned task weights alongside the unchanged base."""
    descriptor = lock.get('visualRouterAdapter')
    if checkpoint != 'multilingual' or descriptor is None:
        return None
    try:
        base_weight = next(entry for entry in lock['checkpoints']['multilingual']
                           if entry['local'] == 'model.safetensors')
        hex_value = lambda value, length: isinstance(value, str) and re.fullmatch('[0-9a-f]{' + str(length) + '}', value)
        identity = {key: descriptor[key] for key in
                    ('baseRevision', 'baseModelSha256', 'sha256', 'presentationSha256', 'components')}
        revision = hashlib.sha1(json.dumps(identity, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()
        if (type(descriptor['version']) is not int or descriptor['version'] != 1
                or descriptor['file'] != 'visual-router-head.safetensors'
                or type(descriptor['size']) is not int or descriptor['size'] <= 0
                or type(descriptor['components']) is not list
                or tuple(descriptor['components']) not in (
                    ('scorer',), ('head', 'type_emb', 'scorer'),
                    ('encoder.layers.21', 'encoder.final_norm', 'head', 'type_emb', 'scorer'))
                or not hex_value(descriptor['baseRevision'], 40)
                or descriptor['baseRevision'] != lock['revision']
                or descriptor['baseModelSha256'] != base_weight['sha256']
                or any(not hex_value(descriptor[key], 64) for key in
                       ('baseModelSha256', 'sha256', 'presentationSha256'))
                or descriptor['revision'] != revision):
            raise ValueError('Invalid visual adapter manifest')
    except (KeyError, TypeError, StopIteration):
        raise ValueError('Invalid visual adapter manifest') from None
    # Acquisition binds the declared presentation into the artifact identity.
    # The worker additionally compares it with its actual routing questions.
    target = Path(destination) / checkpoint / descriptor['file']
    if target.is_file() and target.stat().st_size == descriptor['size'] and digest(target, descriptor):
        return descriptor
    source = Path(__file__).resolve().parent / 'adapters' / descriptor['file']
    if not source.is_file() or source.stat().st_size != descriptor['size'] or not digest(source, descriptor):
        raise ValueError('Bundled visual adapter is missing or failed integrity verification')
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + '.partial')
    with source.open('rb') as incoming, partial.open('wb') as outgoing:
        count = 0
        while block := incoming.read(1024 * 1024):
            count += len(block)
            if count > descriptor['size']:
                raise ValueError('Unexpected visual adapter size')
            outgoing.write(block)
    if partial.stat().st_size != descriptor['size'] or not digest(partial, descriptor):
        raise ValueError('Visual adapter integrity verification failed')
    os.replace(partial, target)
    return descriptor


def acquire(destination, checkpoints):
    lock = json.loads(Path(__file__).with_name('models.lock.json').read_text('utf-8'))
    if not checkpoints or any(c not in lock['checkpoints'] for c in checkpoints):
        raise ValueError('Choose multilingual, english or typed-decisions.')
    destination = Path(destination).resolve()
    for checkpoint in checkpoints:
        entries = lock['checkpoints'][checkpoint]
        started = time.monotonic()
        for entry in entries:
            relative = Path(entry['local'])
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('Invalid manifest path')
            target = destination / checkpoint / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.is_file() and target.stat().st_size == entry['size'] and digest(target, entry):
                continue
            print(f"Downloading {checkpoint}/{entry['local']} ({entry['size']} bytes)", flush=True)
            url = f"https://huggingface.co/{lock['repository']}/resolve/{lock['revision']}/{entry['remote']}"
            partial = target.with_name(target.name + '.partial')
            request = urllib.request.Request(url, headers={'User-Agent': 'DesktopAI-LAYA-setup/1'})
            with urllib.request.urlopen(request, timeout=120) as response, partial.open('wb') as output:
                count = 0
                while block := response.read(1024 * 1024):
                    count += len(block)
                    if count > entry['size']:
                        raise ValueError('Unexpected model download size')
                    output.write(block)
            if partial.stat().st_size != entry['size'] or not digest(partial, entry):
                raise ValueError('Model integrity verification failed')
            os.replace(partial, target)
        adapter = install_visual_adapter(destination, checkpoint, lock)
        record = {'repository': lock['repository'], 'revision': lock['revision'],
                  'checkpoint': checkpoint, 'runtime': lock['runtime'],
                  'bytes': sum(e['size'] for e in entries) + (adapter['size'] if adapter else 0),
                  'downloadSeconds': time.monotonic() - started, 'files': entries}
        if adapter:
            record['visualRouterAdapter'] = adapter
            record['modelRevision'] = adapter['revision']
        (destination / checkpoint / 'desktopai-model.json').write_text(
            json.dumps(record, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({k: v for k, v in record.items() if k != 'files'}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--destination', required=True)
    parser.add_argument('--checkpoints', default='multilingual')
    args = parser.parse_args()
    acquire(args.destination, args.checkpoints.split(','))
