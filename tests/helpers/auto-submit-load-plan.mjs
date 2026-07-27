const PROFILE_IDS = ['profile-a', 'profile-b', 'profile-c'];
const SITE_IDS = ['site-a', 'site-b', 'site-c', 'site-d'];

function createProfiles() {
  return {
    'profile-a': {
      id: 'profile-a',
      displayName: '压力测试作者 A',
      name: 'Alice Load Fixture',
      email: 'alice-load@fixture.test'
    },
    'profile-b': {
      id: 'profile-b',
      displayName: '压力测试作者 B',
      name: 'Bob Load Fixture',
      email: 'bob-load@fixture.test'
    },
    'profile-c': {
      id: 'profile-c',
      displayName: '压力测试作者 C',
      name: 'Carol Load Fixture',
      email: 'carol-load@fixture.test'
    }
  };
}

function createPromotionSites(origins) {
  return Object.fromEntries(SITE_IDS.map((id, index) => [
    id,
    {
      id,
      name: `本地推广网站 ${id.at(-1).toUpperCase()}`,
      url: `${origins[index]}/promotion/${id.at(-1)}`,
      content: `仅用于本地自动提交压力验收的推广说明 ${id}`
    }
  ]));
}

function countBy(values) {
  return Object.fromEntries(
    [...new Set(values)].map((value) => [
      value,
      values.filter((candidate) => candidate === value).length
    ])
  );
}

export function createAutoSubmitLoadPlan(origins) {
  if (
    !Array.isArray(origins) ||
    origins.length !== 6 ||
    new Set(origins).size !== 6
  ) {
    throw new Error('six_blog_origins_required');
  }
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(parsed.hostname)
    ) {
      throw new Error('loopback_blog_origin_required');
    }
  }

  const profiles = createProfiles();
  const promotionSites = createPromotionSites(origins);
  const passwordsByProfileId = {
    'profile-a': 'fixture-secret-a',
    'profile-b': 'fixture-secret-b',
    'profile-c': 'fixture-secret-c'
  };
  const tasks = Array.from({ length: 30 }, (_, index) => {
    const targetId = index + 1;
    const blogIndex = Math.floor(index / 5);
    const profileId = PROFILE_IDS[index % PROFILE_IDS.length];
    const promotionSiteId = SITE_IDS[index % SITE_IDS.length];
    const url = `${origins[blogIndex]}/stress/${targetId}`;
    const handle = {
      type: 'BATCH_HANDLE',
      batchId: 'auto-submit-load-30',
      taskId: `auto-submit-load-30:${targetId}`,
      urlIndex: index,
      attempt: 1,
      url,
      profileId,
      promotionSiteId,
      assignmentPairId: `pair-${profileId}-${promotionSiteId}`,
      assignmentSource: 'stress-plan',
      configRevision: 30,
      automation: {
        autoGenerate: true,
        autoSubmit: true
      },
      profile: structuredClone(profiles[profileId]),
      promotionSite: structuredClone(promotionSites[promotionSiteId])
    };
    return {
      targetId,
      blogIndex,
      origin: origins[blogIndex],
      url,
      profileId,
      promotionSiteId,
      handle
    };
  });

  return {
    concurrency: 5,
    profiles,
    passwordsByProfileId,
    promotionSites,
    tasks,
    expected: {
      commentsPerTargetBlog: countBy(
        tasks.map(({ blogIndex }) => blogIndex)
      ),
      commentsPerProfile: countBy(
        tasks.map(({ profileId }) => profileId)
      ),
      commentsPerPromotionSite: countBy(
        tasks.map(({ promotionSiteId }) => promotionSiteId)
      )
    }
  };
}

