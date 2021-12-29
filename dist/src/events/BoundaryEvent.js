"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.BoundaryEventBehaviour = BoundaryEventBehaviour;
exports.default = BoundaryEvent;

var _Activity = _interopRequireDefault(require("../activity/Activity"));

var _EventDefinitionExecution = _interopRequireDefault(require("../eventDefinitions/EventDefinitionExecution"));

var _messageHelper = require("../messageHelper");

var _shared = require("../shared");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function BoundaryEvent(activityDef, context) {
  return new _Activity.default(BoundaryEventBehaviour, activityDef, context);
}

function BoundaryEventBehaviour(activity) {
  const {
    id,
    type = 'BoundaryEvent',
    broker,
    environment,
    attachedTo,
    behaviour = {},
    eventDefinitions,
    logger
  } = activity;
  const attachedToId = attachedTo.id;
  const cancelActivity = 'cancelActivity' in behaviour ? behaviour.cancelActivity : true;
  const eventDefinitionExecution = eventDefinitions && (0, _EventDefinitionExecution.default)(activity, eventDefinitions, 'execute.bound.completed');
  return {
    id,
    type,
    attachedTo,
    cancelActivity,
    execute
  };

  function execute(executeMessage) {
    const executeContent = (0, _messageHelper.cloneContent)(executeMessage.content);
    const {
      isRootScope,
      executionId,
      inbound
    } = executeContent;
    let parentExecutionId, completeContent;
    const errorConsumerTags = [];
    const shovels = [];

    if (isRootScope) {
      parentExecutionId = executionId;

      if (eventDefinitionExecution && !environment.settings.strict) {
        broker.subscribeTmp('execution', 'execute.expect', onExpectMessage, {
          noAck: true,
          consumerTag: '_expect-tag'
        });
      }

      attachedTo.broker.subscribeTmp('event', 'activity.leave', onAttachedLeave, {
        noAck: true,
        consumerTag: `_bound-listener-${parentExecutionId}`,
        priority: 300
      });
      broker.subscribeOnce('execution', 'execute.detach', onDetachMessage, {
        consumerTag: '_detach-tag'
      });
      broker.subscribeOnce('api', `activity.#.${parentExecutionId}`, onApiMessage, {
        consumerTag: `_api-${parentExecutionId}`
      });
      broker.subscribeOnce('execution', 'execute.bound.completed', onCompleted, {
        consumerTag: `_execution-completed-${parentExecutionId}`
      });
    }

    if (eventDefinitionExecution) eventDefinitionExecution.execute(executeMessage);

    function onCompleted(_, message) {
      if (!cancelActivity && !message.content.cancelActivity) {
        stop();
        return broker.publish('execution', 'execute.completed', (0, _messageHelper.cloneContent)(message.content));
      }

      completeContent = message.content;
      const attachedToContent = inbound && inbound[0];
      logger.debug(`<${executionId} (id)> cancel ${attachedTo.status} activity <${attachedToContent.executionId} (${attachedToContent.id})>`);
      attachedTo.getApi({
        content: attachedToContent
      }).discard();
    }

    function onAttachedLeave(routingKey, message) {
      if (message.content.id !== attachedToId) return;
      stop();
      if (!completeContent) return broker.publish('execution', 'execute.discard', executeContent);
      return broker.publish('execution', 'execute.completed', completeContent);
    }

    function onExpectMessage(_, message) {
      const errorConsumerTag = `_bound-error-listener-${message.content.executionId}`;
      errorConsumerTags.push(errorConsumerTag);
      attachedTo.broker.subscribeTmp('event', 'activity.error', attachedErrorHandler(message.content.expectRoutingKey), {
        noAck: true,
        consumerTag: errorConsumerTag,
        priority: 300
      });
    }

    function attachedErrorHandler(routingKey) {
      return function onAttachedError(_, message) {
        if (message.content.id !== attachedToId) return;
        broker.publish('execution', routingKey, (0, _messageHelper.cloneContent)(message.content));
      };
    }

    function onDetachMessage(_, {
      content
    }) {
      logger.debug(`<${parentExecutionId} (${id})> detach from activity <${attachedTo.id}>`);
      stop(true);
      const {
        executionId: detachId,
        bindExchange,
        sourceExchange = 'execution',
        sourcePattern
      } = content;
      const shovelName = `_detached-${(0, _shared.brokerSafeId)(id)}_${detachId}`;
      shovels.push(shovelName);
      attachedTo.broker.createShovel(shovelName, {
        exchange: sourceExchange,
        pattern: sourcePattern
      }, {
        broker,
        exchange: bindExchange
      }, {
        cloneMessage: _messageHelper.cloneMessage
      });
      broker.subscribeOnce('execution', 'execute.bound.completed', onDetachedCompleted, {
        consumerTag: `_execution-completed-${parentExecutionId}`
      });
    }

    function onDetachedCompleted(_, message) {
      stop();
      return broker.publish('execution', 'execute.completed', (0, _messageHelper.cloneContent)(message.content));
    }

    function onApiMessage(_, message) {
      const messageType = message.properties.type;

      switch (messageType) {
        case 'discard':
          stop();
          break;

        case 'stop':
          stop();
          break;
      }
    }

    function stop(detach) {
      attachedTo.broker.cancel(`_bound-listener-${parentExecutionId}`);
      attachedTo.broker.cancel(`_bound-error-listener-${parentExecutionId}`);

      for (const tag of errorConsumerTags.splice(0)) attachedTo.broker.cancel(tag);

      for (const shovelName of shovels.splice(0)) attachedTo.broker.closeShovel(shovelName);

      broker.cancel('_expect-tag');
      broker.cancel('_detach-tag');
      broker.cancel(`_execution-completed-${parentExecutionId}`);
      if (detach) return;
      broker.cancel(`_api-${parentExecutionId}`);
    }
  }
}