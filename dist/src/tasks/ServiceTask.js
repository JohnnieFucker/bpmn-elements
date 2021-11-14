"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = ServiceTask;
exports.ServiceTaskBehaviour = ServiceTaskBehaviour;

var _Activity = _interopRequireDefault(require("../activity/Activity"));

var _Errors = require("../error/Errors");

var _messageHelper = require("../messageHelper");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function ServiceTask(activityDef, context) {
  return new _Activity.default(ServiceTaskBehaviour, activityDef, context);
}

function ServiceTaskBehaviour(activity) {
  const {
    id,
    type,
    broker,
    logger,
    behaviour,
    environment,
    emitFatal
  } = activity;
  const loopCharacteristics = behaviour.loopCharacteristics && behaviour.loopCharacteristics.Behaviour(activity, behaviour.loopCharacteristics);
  const source = {
    id,
    type,
    loopCharacteristics,
    execute,
    getService
  };
  return source;

  function execute(executeMessage) {
    const content = executeMessage.content;

    if (loopCharacteristics && content.isRootScope) {
      return loopCharacteristics.execute(executeMessage);
    }

    const {
      executionId
    } = content;
    const service = getService(executeMessage);
    if (!service) return emitFatal(new _Errors.ActivityError(`<${id}> service not defined`, executeMessage), content);
    broker.subscribeTmp('api', `activity.#.${content.executionId}`, onApiMessage, {
      consumerTag: `_api-${executionId}`
    });
    return service.execute(executeMessage, (err, output) => {
      broker.cancel(`_api-${executionId}`);

      if (err) {
        logger.error(`<${content.executionId} (${id})>`, err);
        return broker.publish('execution', 'execute.error', (0, _messageHelper.cloneContent)(content, {
          error: new _Errors.ActivityError(err.message, executeMessage, err)
        }, {
          mandatory: true
        }));
      }

      return broker.publish('execution', 'execute.completed', (0, _messageHelper.cloneContent)(content, {
        output,
        state: 'complete'
      }));
    });

    function onApiMessage(_, message) {
      if (message.properties.type === 'discard') {
        broker.cancel(`_api-${executionId}`);
        if (service && service.discard) service.discard(message);
        logger.debug(`<${content.executionId} (${id})> discarded`);
        return broker.publish('execution', 'execute.discard', (0, _messageHelper.cloneContent)(content, {
          state: 'discard'
        }));
      }

      if (message.properties.type === 'stop') {
        broker.cancel(`_api-${executionId}`);
        if (service && service.stop) service.stop(message);
        return logger.debug(`<${content.executionId} (${id})> stopped`);
      }
    }
  }

  function getService(message) {
    const Service = behaviour.Service;

    if (!Service) {
      return environment.settings.enableDummyService ? DummyService(activity) : null;
    }

    return Service(activity, (0, _messageHelper.cloneMessage)(message));
  }

  function DummyService() {
    logger.debug(`<${id}> returning dummy service`);
    return {
      type: 'dummyservice',
      execute: executeDummyService
    };

    function executeDummyService(...args) {
      logger.debug(`<${id}> executing dummy service`);
      const next = args.pop();
      next();
    }
  }
}