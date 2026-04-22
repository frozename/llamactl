import * as React from 'react';
import { lazy } from 'react';
import { TabbedModule } from '@/shell/tabbed-module';

/**
 * Knowledge page — current Knowledge module (retrieval + query)
 * plus Pipelines (ingestion) as sibling tabs. Ingestion and query
 * are the two halves of the same RAG operator story; merging them
 * cuts a top-level module and puts the pipeline-apply flow next
 * to the thing it feeds.
 */

const KnowledgeTab = lazy(() => import('../knowledge/index'));
const PipelinesTab = lazy(() => import('../pipelines/index'));

export default function KnowledgePage(): React.JSX.Element {
  return (
    <TabbedModule
      moduleId="knowledge-page"
      title="Knowledge"
      subtitle="RAG retrieval + ingestion pipelines."
      tabs={[
        { id: 'retrieval', label: 'Retrieval', Component: KnowledgeTab },
        { id: 'pipelines', label: 'Pipelines', Component: PipelinesTab },
      ]}
    />
  );
}
