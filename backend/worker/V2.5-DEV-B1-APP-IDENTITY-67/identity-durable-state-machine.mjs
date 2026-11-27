/**
 * Batch 67: durable identity binding state machine contract.
 * Every mutating store method MUST be implemented as one atomic DB operation
 * (conditional UPDATE/INSERT with UNIQUE constraints or a transaction).
 * This module intentionally contains no D1 SQL and no in-memory production lock.
 */
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const DEVICE=/^[A-Za-z0-9_-]{8,80}$/;
const CODE=/^[A-Z0-9]{4,12}$/;
const fail=code=>({ok:false,code});
const requireFn=(o,n)=>{if(typeof o?.[n]!=="function")throw new TypeError("Missing atomic store method: "+n);};

export function createIdentityDurableStateMachine({store,now=()=>Date.now(),challengeTtlMs=5*60_000,nonceTtlMs=5*60_000}={}) {
  for(const n of ["insertChallenge","consumeChallengeAtomic","consumeNonceAtomic","upsertBindingAtomic","revokeBindingAtomic","rotateShareCodeAtomic","getCurrentShareCode","expireTransientRecords"]) requireFn(store,n);
  if(!Number.isSafeInteger(challengeTtlMs)||challengeTtlMs<10_000||challengeTtlMs>10*60_000) throw new RangeError("challengeTtlMs");
  if(!Number.isSafeInteger(nonceTtlMs)||nonceTtlMs<10_000||nonceTtlMs>10*60_000) throw new RangeError("nonceTtlMs");

  async function issueChallenge({challengeId,deviceId,adminUserId,codeVersion,deviceKeyThumbprint}) {
    if(!ID.test(challengeId||"")||!DEVICE.test(deviceId||"")||!ID.test(adminUserId||"")||
      !Number.isSafeInteger(codeVersion)||codeVersion<1||!ID.test(deviceKeyThumbprint||"")) return fail("IDENTITY_CHALLENGE_INVALID");
    const issuedAt=now(), expiresAt=issuedAt+challengeTtlMs;
    try {
      const result=await store.insertChallenge({challengeId,deviceId,adminUserId,codeVersion,deviceKeyThumbprint,issuedAt,expiresAt,status:"pending"});
      return result?.created===true?{ok:true,challengeId,expiresAt}:fail("IDENTITY_CHALLENGE_CONFLICT");
    } catch { return fail("IDENTITY_STORE_UNAVAILABLE"); }
  }

  async function consumeBindChallenge({challengeId,deviceId,adminUserId,codeVersion,deviceKeyThumbprint,proofVerified}) {
    if(!ID.test(challengeId||"")||!DEVICE.test(deviceId||"")||!ID.test(adminUserId||"")||
      !Number.isSafeInteger(codeVersion)||!ID.test(deviceKeyThumbprint||"")||proofVerified!==true) return fail("IDENTITY_CHALLENGE_INVALID");
    try {
      const result=await store.consumeChallengeAtomic({challengeId,deviceId,adminUserId,codeVersion,deviceKeyThumbprint,consumedAt:now()});
      return result?.consumed===true?{ok:true}:fail(result?.reason==="expired"?"IDENTITY_CHALLENGE_EXPIRED":"IDENTITY_CHALLENGE_ALREADY_USED_OR_MISMATCHED");
    } catch { return fail("IDENTITY_STORE_UNAVAILABLE"); }
  }

  async function consumeRequestNonce({bindingId,deviceId,nonce,proofVerified}) {
    if(!ID.test(bindingId||"")||!DEVICE.test(deviceId||"")||!ID.test(nonce||"")||proofVerified!==true) return fail("IDENTITY_NONCE_INVALID");
    const issuedAt=now();
    try {
      const result=await store.consumeNonceAtomic({bindingId,deviceId,nonce,consumedAt:issuedAt,expiresAt:issuedAt+nonceTtlMs});
      return result?.consumed===true?{ok:true}:fail("IDENTITY_NONCE_REPLAYED_OR_CONFLICTED");
    } catch { return fail("IDENTITY_STORE_UNAVAILABLE"); }
  }

  async function getOrCreateBinding({adminUserId,deviceId,deviceKeyThumbprint,shareCodeVersion}) {
    if(!ID.test(adminUserId||"")||!DEVICE.test(deviceId||"")||!ID.test(deviceKeyThumbprint||"")||
      !Number.isSafeInteger(shareCodeVersion)||shareCodeVersion<1) return fail("IDENTITY_BINDING_INVALID");
    try {
      const result=await store.upsertBindingAtomic({adminUserId,deviceId,deviceKeyThumbprint,shareCodeVersion,now:now()});
      if(!result?.binding||result.binding.status!=="active"||result.binding.adminUserId!==adminUserId||
        result.binding.deviceId!==deviceId||result.binding.deviceKeyThumbprint!==deviceKeyThumbprint) return fail("IDENTITY_BINDING_CONFLICT");
      return {ok:true,binding:result.binding,created:result.created===true};
    } catch { return fail("IDENTITY_STORE_UNAVAILABLE"); }
  }

  async function revokeBinding({bindingId,adminUserId,reason}) {
    if(!ID.test(bindingId||"")||!ID.test(adminUserId||"")||typeof reason!=="string"||!reason.trim()||reason.length>160) return fail("IDENTITY_REVOCATION_INVALID");
    try {
      const result=await store.revokeBindingAtomic({bindingId,adminUserId,reason:reason.trim(),revokedAt:now()});
      return result?.revoked===true?{ok:true}:fail("IDENTITY_BINDING_NOT_FOUND_OR_NOT_OWNED");
    } catch { return fail("IDENTITY_STORE_UNAVAILABLE"); }
  }

  async function rotateShareCode({adminUserId,expectedVersion,newCodeDigest}) {
    if(!ID.test(adminUserId||"")||!Number.isSafeInteger(expectedVersion)||expectedVersion<1||
      typeof newCodeDigest!=="string"||!/^[a-f0-9]{64}$/.test(newCodeDigest)) return fail("IDENTITY_CODE_ROTATION_INVALID");
    try {
      const result=await store.rotateShareCodeAtomic({adminUserId,expectedVersion,newCodeDigest,rotatedAt:now()});
      return result?.rotated===true?{ok:true,newVersion:expectedVersion+1}:fail("IDENTITY_CODE_ROTATION_CONFLICT");
    } catch { return fail("IDENTITY_STORE_UNAVAILABLE"); }
  }

  async function getCurrentCode(adminUserId) {
    if(!ID.test(adminUserId||"")) return null;
    try { const row=await store.getCurrentShareCode(adminUserId); return row?.active===true?row:null; }
    catch { return null; }
  }

  async function cleanupExpired() {
    try {
      const result=await store.expireTransientRecords({now:now(),challengeStatuses:["pending"],nonceStatuses:["consumed"]});
      return {ok:true,expiredChallenges:Number.isSafeInteger(result?.expiredChallenges)?result.expiredChallenges:0,
        expiredNonces:Number.isSafeInteger(result?.expiredNonces)?result.expiredNonces:0};
    } catch { return fail("IDENTITY_STORE_UNAVAILABLE"); }
  }

  return Object.freeze({issueChallenge,consumeBindChallenge,consumeRequestNonce,getOrCreateBinding,revokeBinding,rotateShareCode,getCurrentCode,cleanupExpired});
}

/**
 * Required durable uniqueness/atomicity contract for future D1 adapter:
 * challenge PK(challenge_id); request nonce UNIQUE(binding_id, nonce);
 * binding UNIQUE(admin_user_id, device_id); share-code row UNIQUE(admin_user_id)
 * with monotonic code_version and conditional rotation WHERE code_version=expected.
 * Do not treat these names as verified existing schema or executable migrations.
 */
export const IDENTITY_DURABLE_CONTRACT=Object.freeze({
  challenge:"single-use pending -> consumed; expires_at checked in same atomic consume",
  nonce:"unique (binding_id, nonce); expires_at bounded; insert-if-absent",
  binding:"unique (admin_user_id, device_id); upsert only same device key; revoked rows never silently reactivate",
  shareCode:"monotonic version; compare-and-swap rotation; only one current active version",
  cleanup:"bounded idempotent deletion/expiry of transient challenge and nonce rows; never delete binding/audit history"
});
