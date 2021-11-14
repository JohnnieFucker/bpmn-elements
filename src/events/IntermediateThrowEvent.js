import Activity from '../activity/Activity';
import EventDefinitionExecution from '../eventDefinitions/EventDefinitionExecution';
import {cloneContent} from '../messageHelper';

export default function IntermediateThrowEvent(activityDef, context) {
  return new Activity(IntermediateThrowEventBehaviour, {...activityDef, isThrowing: true}, context);
}

export function IntermediateThrowEventBehaviour(activity) {
  const {id, type, broker, eventDefinitions} = activity;
  const eventDefinitionExecution = eventDefinitions && EventDefinitionExecution(activity, eventDefinitions);

  const source = {
    id,
    type,
    execute,
  };

  return source;

  function execute(executeMessage) {
    if (eventDefinitionExecution) {
      return eventDefinitionExecution.execute(executeMessage);
    }

    return broker.publish('execution', 'execute.completed', cloneContent(executeMessage.content));
  }
}
