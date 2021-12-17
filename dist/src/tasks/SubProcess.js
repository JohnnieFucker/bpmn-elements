"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.SubProcessBehaviour = SubProcessBehaviour;
exports.default = SubProcess;

var _Activity = _interopRequireDefault(require("../activity/Activity"));

var _ProcessExecution = _interopRequireDefault(require("../process/ProcessExecution"));

var _messageHelper = require("../messageHelper");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function SubProcess(activityDef, context) {
  const triggeredByEvent = activityDef.behaviour && activityDef.behaviour.triggeredByEvent;
  const subProcess = new _Activity.default(SubProcessBehaviour, { ...activityDef,
    isSubProcess: true,
    triggeredByEvent
  }, context);

  subProcess.getStartActivities = function getStartActivities(filterOptions) {
    return context.getStartActivities(filterOptions, activityDef.id);
  };

  subProcess.broker.cancel('_api-shake');
  subProcess.broker.subscribeTmp('api', 'activity.shake.*', onShake, {
    noAck: true,
    consumerTag: '_api-shake'
  });
  return subProcess;

  function onShake(_, message) {
    const {
      startId
    } = message.content;
    const last = message.content.sequence.pop();
    const sequence = new _ProcessExecution.default(subProcess, context).shake(startId);
    message.content.sequence.push({ ...last,
      isSubProcess: true,
      sequence
    });
  }
}

function SubProcessBehaviour(activity, context) {
  const {
    id,
    type,
    behaviour
  } = activity;
  this.id = id;
  this.type = type;
  this.executionId = undefined;
  this.loopCharacteristics = behaviour.loopCharacteristics && new behaviour.loopCharacteristics.Behaviour(activity, behaviour.loopCharacteristics);
  this.executions = [];
  this.activity = activity;
  this.context = context;
  this.environment = activity.environment;
  this.broker = activity.broker;
}

const proto = SubProcessBehaviour.prototype;
Object.defineProperty(proto, 'execution', {
  get() {
    return this.executions[0];
  }

});

proto.execute = function execute(executeMessage) {
  const content = executeMessage.content;
  let executionId = this.executionId;

  if (content.isRootScope) {
    executionId = this.executionId = content.executionId;
  }

  const loopCharacteristics = this.loopCharacteristics;

  if (loopCharacteristics && content.isRootScope) {
    this.broker.subscribeTmp('api', `activity.#.${executionId}`, this.onApiRootMessage.bind(this), {
      noAck: true,
      consumerTag: `_api-${executionId}`,
      priority: 200
    });
    return loopCharacteristics.execute(executeMessage);
  }

  const processExecution = this.upsertExecution(executeMessage);
  if (!processExecution) return;
  return processExecution.execute(executeMessage);
};

proto.onApiRootMessage = function onApiRootMessage(_, message) {
  const messageType = message.properties.type;

  switch (messageType) {
    case 'stop':
      this.broker.cancel(message.fields.consumerTag);
      this.stop();
      break;

    case 'discard':
      this.broker.cancel(message.fields.consumerTag);
      this.discard();
      break;
  }
};

proto.stop = function stop() {
  return this.executions.forEach(pe => {
    this.broker.cancel(`_sub-process-execution-${pe.executionId}`);
    this.broker.cancel(`_sub-process-api-${pe.executionId}`);
    pe.stop();
  });
};

proto.discard = function discard() {
  return this.executions.forEach(pe => {
    this.broker.cancel(`_sub-process-execution-${pe.executionId}`);
    this.broker.cancel(`_sub-process-api-${pe.executionId}`);
    pe.discard();
  });
};

proto.getState = function getState() {
  if (this.loopCharacteristics) {
    return {
      executions: this.executions.map(pe => {
        const state = pe.getState();
        state.environment = pe.environment.getState();
        return state;
      })
    };
  }

  const execution = this.execution;

  if (execution) {
    const state = execution.getState();
    state.environment = execution.environment.getState();
    return state;
  }
};

proto.recover = function recover(state) {
  if (!state) return;
  const loopCharacteristics = this.loopCharacteristics;
  const executions = this.executions;

  if (loopCharacteristics && state.executions) {
    executions.splice(0);
    return state.executions.forEach(s => {
      this.recover(s);
    });
  }

  if (!loopCharacteristics) {
    executions.splice(0);
  }

  const subEnvironment = this.environment.clone().recover(state.environment);
  const subContext = this.context.clone(subEnvironment);
  const execution = new _ProcessExecution.default(this.activity, subContext).recover(state);
  executions.push(execution);
  return execution;
};

proto.upsertExecution = function upsertExecution(executeMessage) {
  const content = executeMessage.content;
  const executionId = content.executionId;
  let execution = this.getExecutionById(executionId);

  if (execution) {
    if (executeMessage.fields.redelivered) this.addListeners(execution, executionId);
    return execution;
  }

  const subEnvironment = this.environment.clone({
    output: {}
  });
  const subContext = this.context.clone(subEnvironment);
  execution = new _ProcessExecution.default(this.activity, subContext);
  this.executions.push(execution);
  this.addListeners(execution, executionId);
  return execution;
};

proto.addListeners = function addListeners(processExecution, executionId) {
  this.broker.subscribeTmp('subprocess-execution', `execution.#.${executionId}`, this.onExecutionCompleted.bind(this), {
    noAck: true,
    consumerTag: `_sub-process-execution-${executionId}`
  });
};

proto.onExecutionCompleted = function onExecutionCompleted(_, message) {
  if (message.fields.redelivered && message.properties.persistent === false) return;
  const content = message.content;
  const messageType = message.properties.type;
  const broker = this.broker;

  switch (messageType) {
    case 'stopped':
      {
        broker.cancel(message.fields.consumerTag);
        break;
      }

    case 'discard':
      {
        broker.cancel(message.fields.consumerTag);
        broker.publish('execution', 'execute.discard', (0, _messageHelper.cloneContent)(content));
        break;
      }

    case 'completed':
      {
        broker.cancel(message.fields.consumerTag);
        broker.publish('execution', 'execute.completed', (0, _messageHelper.cloneContent)(content));
        break;
      }

    case 'error':
      {
        broker.cancel(message.fields.consumerTag);
        const {
          error
        } = content;
        this.activity.logger.error(`<${this.id}>`, error);
        broker.publish('execution', 'execute.error', (0, _messageHelper.cloneContent)(content));
        break;
      }
  }
};

proto.getApi = function getApi(apiMessage) {
  const content = apiMessage.content;
  if (content.id === this.id) return;
  let execution;

  if (execution = this.getExecutionById(content.parent.executionId)) {
    return execution.getApi(apiMessage);
  }

  const parentPath = content.parent.path;

  for (let i = 0; i < parentPath.length; i++) {
    if (execution = this.getExecutionById(parentPath[i].executionId)) return execution.getApi(apiMessage);
  }
};

proto.getExecutionById = function getExecutionById(executionId) {
  return this.executions.find(pe => pe.executionId === executionId);
};

proto.getPostponed = function getPostponed() {
  return this.executions.reduce((result, pe) => {
    result = result.concat(pe.getPostponed());
    return result;
  }, []);
};