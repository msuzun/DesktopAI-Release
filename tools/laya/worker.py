"""One resident LAYA agent, bounded JSON-line stdin/stdout protocol, no network.

Embedded by the native host; model acquisition is an explicit separate tool.
Only metadata/errors enter stdout. SDK output and tracebacks are never forwarded.
"""
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import threading
import time

LIMIT = 32768
ROUTES = ('NONE', 'CURRENT', 'CURRENT_EXACT', 'RECENT', 'RECENT_EXACT',
          'FOLLOW_UP_EXACT', 'COMPARE_RECENT_CURRENT')
FLAGS = ('screen_awareness_enabled', 'current_available', 'recent_available',
         'previous_reference_available')
NETWORK_BLOCKS = 0


def network_audit(event, _args):
    global NETWORK_BLOCKS
    if event in ('socket.connect', 'socket.getaddrinfo', 'socket.bind'):
        NETWORK_BLOCKS += 1
        raise PermissionError('Local routing network disabled')


class RoutingFailure(Exception):
    pass


def validate_input(value):
    if not isinstance(value, dict) or set(value) - {'user_utterance', 'previous_turn_context', 'visual_availability'}:
        raise RoutingFailure('invalid_input')
    text, previous, flags = value.get('user_utterance'), value.get('previous_turn_context'), value.get('visual_availability')
    if not isinstance(text, str) or not text.strip() or len(text.encode('utf-8')) > 8192:
        raise RoutingFailure('invalid_input')
    if previous is not None and (not isinstance(previous, str) or len(previous.encode('utf-8')) > 1024):
        raise RoutingFailure('invalid_input')
    if not isinstance(flags, dict) or set(flags) != set(FLAGS) or any(type(v) is not bool for v in flags.values()):
        raise RoutingFailure('invalid_input')
    if not flags['screen_awareness_enabled']:
        raise RoutingFailure('privacy')
    return value


def semantic_state(value):
    """Availability belongs to resolution, never to the requested meaning.

    Preserve the literal message and bounded preceding question. There is no
    keyword extraction, inferred time, or availability-based route substitution.
    """
    state = {'message': value['user_utterance']}
    if value.get('previous_turn_context'):
        state['preceding_visual_question'] = value['previous_turn_context']
    return state


def neutral_questions(questions):
    """Separate public enum names from the model's natural-language choices."""
    model_questions, mappings = {}, {}
    for key, question in questions.items():
        # Native JSON objects have lexically sorted keys. Never let transport
        # serialization change the model's option order or the label mapping.
        options = ROUTES if key == 'visual_route' else tuple(sorted(question['criteria']))
        if set(options) != set(question['criteria']):
            raise RoutingFailure('invalid_input')
        mapping = {chr(65 + index): option for index, option in enumerate(options)}
        mappings[key] = mapping
        model_questions[key] = {**question, 'criteria': {
            label: question['criteria'][option] for label, option in mapping.items()}}
    return model_questions, mappings


def canonical_answer(result, mappings):
    try:
        if set(result['answers']) != set(mappings):
            raise ValueError()
        answers = {}
        for key, mapping in mappings.items():
            answer = result['answers'][key]
            if set(answer['probabilities']) != set(mapping):
                raise ValueError()
            answers[key] = {**answer, 'choice': mapping[answer['choice']],
                            'probabilities': {mapping[label]: p for label, p in answer['probabilities'].items()}}
        return {**result, 'answers': answers}
    except (KeyError, TypeError, ValueError):
        raise RoutingFailure('invalid_result') from None


def parse_answer(result):
    try:
        answers = result['answers']
        if set(answers) != {'visual_route'}:
            raise ValueError()
        answer = answers['visual_route']
        p, confidence, route = answer['probabilities'], answer['confidence'], answer['choice']
        finite = lambda v: type(v) in (float, int) and math.isfinite(v) and 0 <= v <= 1
        if answer['type'] != 'choice' or route not in ROUTES or set(p) != set(ROUTES) or not finite(confidence):
            raise ValueError()
        # LAYA officially rounds each probability to four decimal places.
        if any(not finite(v) for v in p.values()) or abs(sum(p.values()) - 1) > 0.00036:
            raise ValueError()
        if max(p.values()) > p[route] + 0.000001:
            raise ValueError()
        usage = result['usage']
        if any(type(usage[k]) is not int or usage[k] < 0 for k in ('input_tokens', 'output_tokens')):
            raise ValueError()
        return {'route': route, 'confidence': confidence, 'probabilities': p,
                'usage': {k: usage[k] for k in ('input_tokens', 'output_tokens')}}
    except (KeyError, TypeError, ValueError):
        raise RoutingFailure('invalid_result') from None


def compose_answer(result, questions):
    """Map independent learned dimensions into the unchanged M7 route contract.

    No text, fixture identity, or expected label participates in this mapping.
    Confidence and route weights are uncalibrated products, not probabilities
    that have been calibrated for the visual-routing task.
    """
    try:
        answers = result['answers']
        if set(answers) != set(questions):
            raise ValueError()
        probabilities = {}
        for key, question in questions.items():
            answer = answers[key]
            p = answer['probabilities']
            if (answer['type'] != 'choice' or set(p) != set(question['criteria'])
                    or answer['choice'] not in p
                    or any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in p.values())
                    or abs(sum(p.values()) - 1) > len(p) * 0.000051
                    or p[answer['choice']] < max(p.values())):
                raise ValueError()
            probabilities[key] = {k: v / sum(p.values()) for k, v in p.items()}
        need, source, precision, relation = (probabilities[k] for k in
                                             ('visual_need', 'temporal_source', 'precision', 'relation'))
        single = need['VISUAL'] * relation['SINGLE']
        p = {'NONE': need['NONVISUAL'],
             'CURRENT': single * source['CURRENT'] * precision['NORMAL'],
             'CURRENT_EXACT': single * source['CURRENT'] * precision['EXACT'],
             'RECENT': single * source['RECENT'] * precision['NORMAL'],
             'RECENT_EXACT': single * source['RECENT'] * precision['EXACT'],
             'FOLLOW_UP_EXACT': single * source['PREVIOUS_REFERENCE'],
             'COMPARE_RECENT_CURRENT': need['VISUAL'] * relation['COMPARE']}
        # Select each learned dimension before mapping. Marginal argmax over
        # all final routes unfairly divides visual mass among six classes and
        # can choose NONE despite the model choosing VISUAL.
        choices = {key: answers[key]['choice'] for key in questions}
        if choices['visual_need'] == 'NONVISUAL':
            route = 'NONE'
        elif choices['relation'] == 'COMPARE':
            route = 'COMPARE_RECENT_CURRENT'
        elif choices['temporal_source'] == 'PREVIOUS_REFERENCE':
            route = 'FOLLOW_UP_EXACT'
        else:
            route = choices['temporal_source'] + ('_EXACT' if choices['precision'] == 'EXACT' else '')
        confidence = max(0, 1 + sum(v * math.log(v) for v in p.values() if v) / math.log(len(p)))
        # Validate usage and the derived distribution with the direct parser,
        # then retain the dimension-mapped route. Marginal weights are exposed
        # for diagnostics; they do not select the compositional result.
        validated = parse_answer({'answers': {'visual_route': {'type': 'choice', 'choice': max(p, key=p.get),
                            'probabilities': p, 'confidence': confidence}}, 'usage': result['usage']})
        return {**validated, 'route': route, 'dimensions': choices}
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        raise RoutingFailure('invalid_result') from None


def verify_model(path, checkpoint, lock):
    if checkpoint not in lock['checkpoints'] or not path.is_dir():
        raise RoutingFailure('model_missing')
    for entry in lock['checkpoints'][checkpoint]:
        target = path / entry['local']
        if not target.is_file() or target.stat().st_size != entry['size']:
            raise RoutingFailure('model_missing')
        digest = hashlib.sha256() if 'sha256' in entry else hashlib.sha1()
        if 'gitBlob' in entry:
            digest.update(f"blob {entry['size']}\0".encode())
        with target.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        if digest.hexdigest() != entry.get('sha256', entry.get('gitBlob')):
            raise RoutingFailure('load_failed')


STATE_FORMAT = 'message-and-preceding-visual-question-v1'
ALLOWED_COMPONENTS = (
    ('scorer',),
    ('head', 'type_emb', 'scorer'),
    ('encoder.layers.21', 'encoder.final_norm', 'head', 'type_emb', 'scorer'),
)


def presentation_hash(questions, routes):
    contract = {'stateFormat': STATE_FORMAT, 'routes': list(routes), 'questions': questions}
    return hashlib.sha256(json.dumps(contract, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def adapter_revision(descriptor):
    identity = {key: descriptor[key] for key in
                ('baseRevision', 'baseModelSha256', 'sha256', 'presentationSha256', 'components')}
    return hashlib.sha1(json.dumps(identity, sort_keys=True,
                                  separators=(',', ':')).encode('utf-8')).hexdigest()


def load_visual_adapter(model_path, config, agent, questions, routes, failure_type):
    """Only the task-specific components of the original verified LAYA model."""
    if config['checkpoint'] != 'multilingual' or config.get('strategy', 'direct') != 'direct':
        return None
    descriptor = config['lock'].get('visualRouterAdapter')
    if descriptor is None:
        return None
    try:
        base_weight = next(entry for entry in config['lock']['checkpoints']['multilingual']
                           if entry['local'] == 'model.safetensors')
        components = tuple(descriptor['components'])
        if (type(descriptor['version']) is not int or descriptor['version'] != 1
                or type(descriptor['size']) is not int or descriptor['size'] <= 0
                or descriptor['file'] != 'visual-router-head.safetensors'
                or type(descriptor['components']) is not list
                or components not in ALLOWED_COMPONENTS
                or descriptor['baseRevision'] != config['lock']['revision']
                or descriptor['baseModelSha256'] != base_weight['sha256']
                or descriptor['presentationSha256'] != presentation_hash(questions, routes)
                or descriptor['revision'] != adapter_revision(descriptor)):
            raise failure_type('load_failed')
        path = Path(model_path) / descriptor['file']
        if not path.is_file() or path.stat().st_size != descriptor['size']:
            raise failure_type('model_missing')
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        if digest.hexdigest() != descriptor['sha256']:
            raise failure_type('load_failed')
        import torch
        from safetensors.torch import load_file
        weights = load_file(str(path), device='cpu')
        prefixes = tuple(component + '.' for component in components)
        expected = {key: tensor for key, tensor in agent.model.state_dict().items()
                    if key.startswith(prefixes)}
        if (not expected or set(weights) != set(expected)
                or any(tensor.shape != expected[key].shape
                       or tensor.dtype != torch.float32
                       or not torch.isfinite(tensor).all()
                       for key, tensor in weights.items())):
            raise failure_type('load_failed')
        for component in components:
            prefix = component + '.'
            agent.model.get_submodule(component).load_state_dict(
                {key[len(prefix):]: tensor for key, tensor in weights.items()
                 if key.startswith(prefix)}, strict=True)
        return {key: descriptor[key] for key in
                ('revision', 'sha256', 'components', 'presentationSha256')}
    except failure_type:
        raise
    except (MemoryError, ModuleNotFoundError):
        raise
    except Exception as error:
        if type(error).__name__ == 'OutOfMemoryError':
            raise
        raise failure_type('load_failed') from None


class LocalEngine:
    def __init__(self, config):
        started = time.perf_counter()
        self.config, self.count = config, 0
        self.baseline = None
        self.agent = None
        if config.get('device') not in ('cpu', 'cuda'):
            raise RoutingFailure('unsupported_device')
        model_path = Path(config['modelPath'])
        if not model_path.is_absolute():
            raise RoutingFailure('model_missing')
        verify_model(model_path, config['checkpoint'], config['lock'])
        import psutil
        self.process = psutil.Process()
        self.baseline = self.memory()
        import torch
        import laya
        if laya.__version__ != config['lock']['runtime']:
            raise RoutingFailure('load_failed')
        if config['device'] == 'cuda' and not torch.cuda.is_available():
            raise RoutingFailure('unsupported_device')
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        self.runtime = laya.__version__
        self.torch_version = torch.__version__
        self.agent = laya.load(str(model_path), device=config['device'])
        self.strategy = config.get('strategy', 'direct')
        if self.strategy not in ('direct', 'compositional'):
            raise RoutingFailure('invalid_input')
        self.questions = config['compositionalSpec']['questions'] if self.strategy == 'compositional' else {'visual_route': {'type': 'choice',
                          'instructions': config['spec']['instructions'],
                          'criteria': config['spec']['criteria']}}
        self.model_questions, self.option_mappings = neutral_questions(self.questions)
        tok = self.agent.tok
        # Preserve all canonical definitions, rather than silently truncate them
        # to the SDK's small default question budget. This is not label tuning.
        self.head_tokens = 0
        for question in self.model_questions.values():
            count = len(tok('choice question: ' + question['instructions'], add_special_tokens=False)['input_ids'])
            for name, description in question['criteria'].items():
                tokens = tok(' ' + name + ': ' + description, add_special_tokens=False)['input_ids']
                if len(tokens) > 48:
                    raise RoutingFailure('invalid_input')
                count += 1 + len(tokens)
            self.head_tokens = max(self.head_tokens, count)
        self.agent.cfg['head_max_len'] = max(self.agent.cfg['head_max_len'], self.head_tokens)
        if self.head_tokens + 4 >= self.agent.cfg['max_len']:
            raise RoutingFailure('invalid_input')
        self.adapter = load_visual_adapter(model_path, config, self.agent,
                                           self.model_questions, ROUTES, RoutingFailure)
        self.load_ms = (time.perf_counter() - started) * 1000

    def memory(self):
        mem = self.process.memory_info()
        return {'rssBytes': mem.rss, 'privateBytes': getattr(mem, 'private', mem.rss)}

    def status(self):
        return {'runtimeVersion': self.runtime, 'torchVersion': self.torch_version,
                'modelVersion': self.adapter['revision'] if self.adapter else self.config['lock']['revision'],
                'baseModelVersion': self.config['lock']['revision'],
                'visualRouterAdapter': self.adapter, 'checkpoint': self.config['checkpoint'],
                'device': str(self.agent.device), 'loadMs': self.load_ms, 'baselineMemory': self.baseline,
                'memory': self.memory(), 'pid': os.getpid(), 'inferences': self.count,
                'networkBlocks': NETWORK_BLOCKS, 'headMaxLen': self.agent.cfg['head_max_len'],
                'strategy': self.strategy,
                'compositionMethod': 'dimension-choice-v1' if self.strategy == 'compositional' else None,
                'maxLen': self.agent.cfg['max_len']}

    def decide(self, value):
        value = validate_input(value)
        state = semantic_state(value)
        tok = self.agent.tok
        state_tokens = tok(json.dumps(state, ensure_ascii=False).replace(tok.mask_token, ' '),
                           add_special_tokens=False)['input_ids']
        if len(state_tokens) + self.head_tokens + 4 > self.agent.cfg['max_len']:
            raise RoutingFailure('invalid_input')
        start, cpu = time.perf_counter(), time.process_time()
        result = canonical_answer(self.agent.predict(state, self.model_questions), self.option_mappings)
        answer = compose_answer(result, self.questions) if self.strategy == 'compositional' else parse_answer(result)
        answer.update({'inferenceMs': (time.perf_counter() - start) * 1000,
                       'cpuMs': (time.process_time() - cpu) * 1000, 'coldStart': self.count == 0})
        self.count += 1
        answer['status'] = self.status()
        return answer


def parent_watch():
    if os.name != 'nt':
        return
    # Release the worker even if the GUI is killed during an inference.
    import ctypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForMultipleObjects.argtypes = [ctypes.c_ulong, ctypes.POINTER(ctypes.c_void_p), ctypes.c_int, ctypes.c_ulong]
    kernel.WaitForMultipleObjects.restype = ctypes.c_ulong
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    # Watch both the host and an intervening venv launcher. Host death and
    # explicit launcher termination must release even an active inference/load.
    parent_pid = int(os.environ.pop('COMPANION_ROUTING_PARENT_PID', str(os.getppid())))
    handles = [kernel.OpenProcess(0x00100000, False, pid) for pid in {parent_pid, os.getppid()}]
    if not all(handles):
        os._exit(0)
    kernel.WaitForMultipleObjects(len(handles), (ctypes.c_void_p * len(handles))(*handles), False, 0xFFFFFFFF)
    for handle in handles:
        kernel.CloseHandle(handle)
    os._exit(0)


def failure(error):
    if isinstance(error, RoutingFailure):
        return str(error)
    if isinstance(error, (MemoryError,)) or type(error).__name__ == 'OutOfMemoryError':
        return 'out_of_memory'
    if isinstance(error, ModuleNotFoundError):
        return 'runtime_missing'
    return 'inference_failed'


def main():
    for key in ('JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN'):
        os.environ.pop(key, None)
    os.environ.update({'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1',
                       'DO_NOT_TRACK': '1', 'USE_TF': '0', 'TOKENIZERS_PARALLELISM': 'false'})
    sys.addaudithook(network_audit)
    threading.Thread(target=parent_watch, daemon=True).start()
    output = sys.stdout.buffer
    engine = None
    while True:
        line = sys.stdin.buffer.readline(LIMIT + 1)
        if not line:
            break
        if len(line) > LIMIT or not line.endswith(b'\n'):
            break
        request_id = None
        try:
            request = json.loads(line)
            request_id = request['id']
            if type(request_id) is not int or request_id < 0:
                raise RoutingFailure('invalid_input')
            with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                if request['operation'] == 'initialize' and engine is None:
                    engine = LocalEngine(request['config'])
                    result = engine.status()
                elif request['operation'] == 'decide' and engine is not None:
                    result = engine.decide(request['input'])
                elif request['operation'] == 'status' and engine is not None:
                    result = engine.status()
                elif request['operation'] == 'shutdown':
                    break
                else:
                    raise RoutingFailure('invalid_input')
            response = {'id': request_id, 'result': result}
        except Exception as error:
            response = {'id': request_id, 'failure': failure(error)}
        output.write(json.dumps(response, allow_nan=False, separators=(',', ':')).encode('utf-8') + b'\n')
        output.flush()
        # Drop the completed request before blocking for another turn. Keeping
        # the resident model must not retain the last utterance during idle time.
        request = result = response = None
        line = b''


if __name__ == '__main__':
    main()
