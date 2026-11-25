from temporalio import workflow


@workflow.defn
class SyntheticEcho:
    @workflow.run
    async def run(self, marker: str) -> str:
        return marker
