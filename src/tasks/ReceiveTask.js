import Activity from '../activity/Activity';
import getPropertyValue from '../getPropertyValue';
import {cloneContent} from '../messageHelper';

export default function ReceiveTask(activityDef, context) {
  const task = Activity(ReceiveTaskBehaviour, activityDef, context);

  task.broker.assertQueue('message', {autoDelete: false, durable: true});
  task.broker.bindQueue('message', 'api', '*.message.#', {durable: true});

  return task;
}

export function ReceiveTaskBehaviour(activity) {
  const {id, type, broker, logger, behaviour = {}, getActivityById} = activity;
  const reference = behaviour.messageRef || {name: 'anonymous'};

  const referenceElement = reference.id && getActivityById(reference.id);
  const loopCharacteristics = behaviour.loopCharacteristics && behaviour.loopCharacteristics.Behaviour(activity, behaviour.loopCharacteristics);

  const source = {
    id,
    type,
    reference: {...reference, referenceType: 'message'},
    execute,
  };

  return source;

  function execute(executeMessage) {
    const content = executeMessage.content;
    if (loopCharacteristics && content.isRootScope) {
      return loopCharacteristics.execute(executeMessage);
    }

    let completed;

    const messageContent = cloneContent(executeMessage.content);
    const {executionId} = messageContent;

    const {message: referenceMessage, description} = resolveReference(executeMessage);
    broker.consume('message', onCatchMessage, {noAck: true, consumerTag: `_onmessage-${executionId}`});

    if (completed) return;

    broker.subscribeTmp('api', `activity.#.${executionId}`, onApiMessage, {noAck: true, consumerTag: `_api-${executionId}`, priority: 400});

    logger.debug(`<${executionId} (${id})> expect ${description}`);

    broker.publish('event', 'activity.wait', {
      ...messageContent,
      message: {...referenceMessage},
    });

    function onCatchMessage(routingKey, message) {
      if (getPropertyValue(message, 'content.message.id') !== referenceMessage.id) return;

      logger.debug(`<${executionId} (${id})> caught ${description}`);
      broker.publish('event', 'activity.catch', {
        ...messageContent,
        message: message.content.message,
      }, {type: 'catch'});

      complete(message.content.message);
    }

    function onApiMessage(routingKey, message) {
      switch (message.properties.type) {
        case 'message':
        case 'signal': {
          return complete(message.content.message);
        }
        case 'discard': {
          completed = true;
          stop();
          return broker.publish('execution', 'execute.discard', {...messageContent});
        }
        case 'stop': {
          return stop();
        }
      }
    }

    function complete(output) {
      completed = true;
      stop();
      return broker.publish('execution', 'execute.completed', {...messageContent, output});
    }

    function stop() {
      broker.cancel(`_onmessage-${executionId}`);
      broker.cancel(`_api-${executionId}`);
      broker.purgeQueue('message');
    }
  }

  function resolveReference(message) {
    if (!referenceElement) {
      return {
        message: {...reference},
        description: 'anonymous message',
      };
    }

    const result = {
      message: referenceElement.resolve(message),
    };

    result.description = `${result.message.name} <${result.message.id}>`;

    return result;
  }
}
