SELECT
  table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name = 'SalesTask';

SELECT
  column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'SalesTask'
  AND column_name IN ('negotiationMemo', 'testingMemo')
ORDER BY column_name;
