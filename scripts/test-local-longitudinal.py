import importlib.util, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('runner',Path(__file__).with_name('run-local-longitudinal.py'))
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)

class MeasurementContract(unittest.TestCase):
    def test_normal_evidence_mapping_is_not_llm_fallback(self):
        result={'metrics':{'llmBackend':'ollama'},'agents':[{'selected':True,'inference':{'role':'evidence-projection','answerSource':'deterministic-fallback'}}]}
        self.assertEqual(runner.inference_classification(result),(False,True))
        result['agents'][0]['inference']['role']='agent-llm'
        self.assertEqual(runner.inference_classification(result),(True,False))

    def test_fast_fallback_does_not_improve_llm_latency_and_missing_tokens_stay_missing(self):
        records=[dict(mode='proposed',caseId='A',status='completed',realLlm=True,latencyMs=100,calls=1,completionTokens=10,ttftMs=5,tpotMs=2,tokensPerSecond=500,providerSamples=[dict(ttftMs=5,tpotMs=2,tokensPerSecond=500)],agentF1=100),
                 dict(mode='proposed',caseId='A',status='completed',realLlm=False,fallback=True,latencyMs=1,calls=0,completionTokens=None,agentF1=0),
                 dict(mode='proposed',caseId='B',status='failed')]
        report=runner.summarize(dict(startedAt='test',deadlineAt=1,dataset={},health={}),records,'running')
        row=next(r for r in report['rows'] if r['mode']=='proposed')
        self.assertEqual((row['n'],row['completed'],row['realLlmCompleted'],row['fallback'],row['uniqueQueries']),(3,2,1,1,2))
        self.assertEqual(row['latencyMs'],100)
        self.assertEqual(row['tokens'],10);self.assertEqual(row['measuredTokenSamples'],1)
        records[0]['providerSamples'][0]['tokensPerSecond']=None
        self.assertFalse(runner.complete_metrics(records[0]))

    def test_repeated_samples_are_counted_by_query_and_mode_before_stopping(self):
        row=dict(caseId='A',status='completed',realLlm=True,latencyMs=100,calls=1,completionTokens=10,ttftMs=5,tpotMs=2,tokensPerSecond=500,providerSamples=[dict(ttftMs=5,tpotMs=2,tokensPerSecond=500)])
        rows=[dict(row,mode=mode) for mode in runner.MODES for _ in range(3)]
        self.assertTrue(runner.stopping_evidence([dict(id='A')],rows,3)['ready'])
        rows.pop();self.assertFalse(runner.stopping_evidence([dict(id='A')],rows,3)['ready'])

    def test_fact_check_does_not_score_question_echo_and_rejects_explicit_negation(self):
        spec=importlib.util.spec_from_file_location('facts',Path(__file__).with_name('public-fact-evaluation.py'));facts=importlib.util.module_from_spec(spec);spec.loader.exec_module(facts)
        cases,_=facts.load_cases();case=cases[0]
        self.assertEqual(facts.evaluate(case,dict(query='30종',conclusion='문서에 수치가 없습니다.'))['factCoverage'],0)
        self.assertEqual(facts.evaluate(case,dict(conclusion='제공되는 모델은 30종입니다.'))['factCoverage'],100)
        self.assertEqual(facts.evaluate(case,dict(conclusion='제공되는 모델은 30종이 아닙니다.'))['factCoverage'],0)
        echo=next(c for c in cases if c['id']=='FACT10')
        self.assertEqual(facts.evaluate(echo,dict(conclusion='요청 Q1: '+echo['query']))['factCoverage'],0)

if __name__=='__main__':unittest.main()
