`candidate_facts` is append-only by revision.
A current fact is identified by candidate, semantic key, and normalized scope.
Updating a fact supersedes the prior row in one transaction.
Each revision stores its typed JSON value, source, source detail, confidence, sensitivity, reuse policy, and timestamps.
