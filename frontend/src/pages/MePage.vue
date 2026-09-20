<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";
import type { DetailSuggestion, Paged, Spot } from "@/api/types";
import { useAuthStore } from "@/stores/auth";
import { useCatalogStore } from "@/stores/catalog";

const auth = useAuthStore();
const catalog = useCatalogStore();
const router = useRouter();

const tab = ref("contributions");
const spots = ref<Spot[]>([]);
const favorites = ref<Spot[]>([]);
const suggestions = ref<DetailSuggestion[]>([]);
const contributions = ref<DetailSuggestion[]>([]);
const pendingSuggestionCount = ref(0);
const statusFilter = ref<string>("");
const loading = ref(false);

const settings = ref({ defaultFuzzRadius: 50, notifyEmail: true, notifyInapp: true });
const passwordForm = ref({ currentPassword: "", newPassword: "" });

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  pending: "待审核",
  in_review: "审核中",
  auto_rejected: "自动预检未通过",
  changes_requested: "需要修改",
  published: "已发布",
  rejected: "未通过",
  appealing: "申诉中",
  rejected_final: "终审未通过",
  hidden: "已下架",
  archived: "已归档",
};

function statusTagType(status: string): "success" | "warning" | "danger" | "info" {
  if (status === "published") return "success";
  if (["rejected", "rejected_final", "hidden"].includes(status)) return "danger";
  if (["pending", "in_review", "appealing"].includes(status)) return "warning";
  return "info";
}

async function loadContributions() {
  loading.value = true;
  try {
    const result = await api.get<Paged<Spot>>("/me/spots", {
      status: statusFilter.value || undefined,
      pageSize: 50,
    });
    spots.value = result.items;
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

async function loadFavorites() {
  const result = await api.get<Paged<Spot>>("/me/favorites", { pageSize: 50 });
  favorites.value = result.items;
}

// ---------------------------------------------------------------- 评论补充建议

const SUGGESTION_STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  accepted: "已采纳",
  rejected: "未采纳",
  expired: "已失效",
};

function suggestionTagType(status: string): "success" | "warning" | "info" | "danger" {
  if (status === "accepted") return "success";
  if (status === "pending") return "warning";
  if (status === "rejected") return "danger";
  return "info";
}

function describeSuggestionValue(item: DetailSuggestion): string {
  const category = catalog.byCode(item.category.code);
  const property = category?.schema.properties[item.fieldKey];

  if (typeof item.proposedValue === "boolean") return item.proposedValue ? "是" : "否";
  if (typeof item.proposedValue === "number") {
    return `${item.proposedValue}${property?.unit ?? ""}`;
  }
  if (Array.isArray(item.proposedValue)) {
    return item.proposedValue
      .map((value) => property?.items?.enumLabels?.[String(value)] ?? String(value))
      .join("、");
  }
  if (typeof item.proposedValue === "string") {
    return property?.enumLabels?.[item.proposedValue] ?? item.proposedValue;
  }
  return String(item.proposedValue ?? "");
}

async function loadSuggestions() {
  const result = await api.get<Paged<DetailSuggestion>>("/me/suggestions", {
    status: "pending",
    pageSize: 50,
  });
  suggestions.value = result.items;
  pendingSuggestionCount.value = result.total;
}

async function loadContributedSuggestions() {
  const result = await api.get<Paged<DetailSuggestion>>("/me/suggestions/contributed", {
    pageSize: 50,
  });
  contributions.value = result.items;
}

async function acceptSuggestion(item: DetailSuggestion) {
  try {
    await api.post(`/suggestions/${item.id}/accept`);
    ElMessage.success(`已把「${item.fieldLabel}」补充到条目`);
    await Promise.all([loadSuggestions(), loadContributedSuggestions()]);
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

async function rejectSuggestion(item: DetailSuggestion) {
  try {
    const { value } = await ElMessageBox.prompt("可以填写不采纳的原因（选填，会通知评论作者）", "不采纳", {
      confirmButtonText: "确认",
      cancelButtonText: "取消",
      inputValidator: (text) => !text || text.trim().length <= 200 || "理由不超过 200 字",
    });
    await api.post(`/suggestions/${item.id}/reject`, { reason: value?.trim() || undefined });
    ElMessage.success("已忽略");
    await loadSuggestions();
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

async function loadSettings() {
  const result = await api.get<{ settings: typeof settings.value }>("/me/settings");
  settings.value = result.settings;
}

async function withdraw(uuid: string) {
  try {
    await ElMessageBox.confirm("撤回后这条记录会回到草稿状态，确定撤回吗？", "撤回提交", {
      confirmButtonText: "撤回",
      cancelButtonText: "取消",
    });
    await api.post(`/spots/${uuid}/withdraw`);
    ElMessage.success("已撤回，可以继续编辑");
    await loadContributions();
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

async function appeal(uuid: string) {
  try {
    const { value } = await ElMessageBox.prompt("请说明申诉理由（至少 10 个字）", "提出申诉", {
      inputValidator: (text) => (text && text.trim().length >= 10 ? true : "请至少写 10 个字"),
    });
    await api.post(`/spots/${uuid}/appeal`, { reason: value.trim() });
    ElMessage.success("申诉已提交，管理员会终审");
    await loadContributions();
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

async function requestManualReview(uuid: string) {
  try {
    await api.post(`/spots/${uuid}/request-manual-review`);
    ElMessage.success("已转人工复核");
    await loadContributions();
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

async function saveSettings() {
  try {
    await api.patch("/me/settings", settings.value);
    ElMessage.success("设置已保存");
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

async function changePassword() {
  if (!passwordForm.value.currentPassword || !passwordForm.value.newPassword) {
    ElMessage.warning("请填写完整");
    return;
  }
  try {
    await api.patch("/auth/password", passwordForm.value);
    ElMessage.success("密码已更新，其他设备的登录已失效");
    passwordForm.value = { currentPassword: "", newPassword: "" };
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

async function deleteAccount() {
  try {
    await ElMessageBox.confirm(
      "注销后你的昵称会变为「已注销用户」，已发布的记录会匿名保留在地图上。这个操作不可撤销。",
      "注销账号",
      { confirmButtonText: "确认注销", cancelButtonText: "再想想", type: "warning" },
    );
    const message = await auth.deleteAccount();
    ElMessage.success(message);
    void router.push({ name: "map" });
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

onMounted(async () => {
  await catalog.load().catch(() => undefined);
  await Promise.all([
    loadContributions(),
    loadFavorites(),
    loadSettings(),
    loadSuggestions(),
    loadContributedSuggestions(),
  ]);
});
</script>

<template>
  <div class="page">
    <h1 class="page-title">我的空间</h1>

    <el-tabs v-model="tab">
      <el-tab-pane label="我的记录" name="contributions">
        <div style="display: flex; gap: 10px; margin-bottom: 12px; align-items: center">
          <el-select v-model="statusFilter" placeholder="全部状态" clearable style="width: 180px" @change="loadContributions">
            <el-option v-for="(label, value) in STATUS_LABEL" :key="value" :label="label" :value="value" />
          </el-select>
          <el-button type="primary" @click="router.push({ name: 'spot-new' })">记录新细节</el-button>
          <span class="muted">
            信用分 {{ auth.user?.creditScore }} · 已通过 {{ auth.user?.approvedCount }} 条
          </span>
        </div>

        <div v-loading="loading">
          <el-empty v-if="!loading && spots.length === 0" description="还没有记录，去地图上添加第一个吧" />

          <el-card v-for="spot in spots" :key="spot.uuid" shadow="never" style="margin-bottom: 10px">
            <div style="display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap">
              <div>
                <el-tag :type="statusTagType(spot.status)" size="small">
                  {{ STATUS_LABEL[spot.status] ?? spot.status }}
                </el-tag>
                <span style="margin-left: 8px; font-weight: 600">{{ spot.title }}</span>
                <div class="muted" style="margin-top: 4px">
                  {{ spot.category.name }} ·
                  {{ new Date(spot.createdAt).toLocaleDateString("zh-CN") }}
                </div>
              </div>

              <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start">
                <el-button size="small" @click="router.push({ name: 'spot-detail', params: { uuid: spot.uuid } })">
                  查看
                </el-button>
                <el-button
                  v-if="['draft', 'changes_requested', 'auto_rejected', 'rejected'].includes(spot.status)"
                  size="small"
                  @click="router.push({ name: 'spot-edit', params: { uuid: spot.uuid } })"
                >
                  继续编辑
                </el-button>
                <el-button v-if="['pending', 'in_review'].includes(spot.status)" size="small" @click="withdraw(spot.uuid)">
                  撤回
                </el-button>
                <el-button v-if="spot.status === 'auto_rejected'" size="small" @click="requestManualReview(spot.uuid)">
                  转人工复核
                </el-button>
                <el-button v-if="spot.status === 'rejected'" size="small" type="warning" @click="appeal(spot.uuid)">
                  申诉
                </el-button>
              </div>
            </div>
          </el-card>
        </div>
      </el-tab-pane>

      <el-tab-pane label="我的收藏" name="favorites">
        <el-empty v-if="favorites.length === 0" description="还没有收藏任何地点" />
        <el-card v-for="spot in favorites" :key="spot.uuid" shadow="never" style="margin-bottom: 10px">
          <div style="display: flex; justify-content: space-between; gap: 12px">
            <div>
              <span class="category-chip" :style="{ background: spot.category.color }">{{ spot.category.name }}</span>
              <span style="margin-left: 8px; font-weight: 600">{{ spot.title }}</span>
            </div>
            <el-button size="small" @click="router.push({ name: 'spot-detail', params: { uuid: spot.uuid } })">
              查看
            </el-button>
          </div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane name="suggestions">
        <template #label>
          <span>待确认补充<el-badge v-if="pendingSuggestionCount" :value="pendingSuggestionCount" style="margin-left: 6px" /></span>
        </template>

        <p class="muted" style="margin: 0 0 12px">
          其他用户在你发布的地点评论里提到了新的现场细节，采纳后会自动写回条目；30 天未处理会自动失效。
        </p>
        <el-empty v-if="suggestions.length === 0" description="暂时没有需要确认的补充" />

        <el-card v-for="item in suggestions" :key="item.id" shadow="never" style="margin-bottom: 10px">
          <div style="display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap">
            <div style="min-width: 240px">
              <strong>{{ item.spotTitle }}</strong>
              <p style="margin: 6px 0 0">
                {{ item.fieldLabel }}
                <el-tag size="small" type="success" effect="plain" style="margin-left: 6px">
                  建议填：{{ describeSuggestionValue(item) }}
                </el-tag>
                <el-tag v-if="item.supportCount > 1" size="small" type="info" effect="plain" style="margin-left: 6px">
                  {{ item.supportCount }} 人提到
                </el-tag>
              </p>
              <p class="muted" style="margin: 6px 0 0; font-size: 13px">「{{ item.evidence }}」</p>
            </div>
            <div style="display: flex; gap: 6px; align-items: flex-start">
              <el-button size="small" type="primary" @click="acceptSuggestion(item)">采纳并补充</el-button>
              <el-button size="small" @click="rejectSuggestion(item)">不采纳</el-button>
              <el-button
                size="small"
                @click="router.push({ name: 'spot-detail', params: { uuid: item.spotUuid } })"
              >
                查看条目
              </el-button>
            </div>
          </div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="我的补充" name="contributed-detail">
        <p class="muted" style="margin: 0 0 12px">你在评论里补充过的结构化细节，以及发布者是否采纳。</p>
        <el-empty v-if="contributions.length === 0" description="还没有从你的评论里识别出可补充的细节" />

        <el-card v-for="item in contributions" :key="item.id" shadow="never" style="margin-bottom: 10px">
          <div style="display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap">
            <div>
              <el-tag size="small" :type="suggestionTagType(item.status)">
                {{ SUGGESTION_STATUS_LABEL[item.status] ?? item.status }}
              </el-tag>
              <strong style="margin-left: 8px">{{ item.spotTitle }}</strong>
              <p style="margin: 6px 0 0">
                {{ item.fieldLabel }}：{{ describeSuggestionValue(item) }}
              </p>
              <p class="muted" style="margin: 4px 0 0; font-size: 13px">「{{ item.evidence }}」</p>
              <p v-if="item.declineReason" class="muted" style="margin: 4px 0 0; font-size: 13px">
                未采纳原因：{{ item.declineReason }}
              </p>
            </div>
            <el-button
              size="small"
              @click="router.push({ name: 'spot-detail', params: { uuid: item.spotUuid } })"
            >
              查看条目
            </el-button>
          </div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="账号设置" name="settings">
        <el-card shadow="never">
          <el-form label-position="top">
            <el-form-item label="默认位置模糊半径">
              <el-select v-model="settings.defaultFuzzRadius" style="width: 160px">
                <el-option label="20 米" :value="20" />
                <el-option label="50 米" :value="50" />
                <el-option label="100 米" :value="100" />
              </el-select>
            </el-form-item>
            <el-form-item label="通知方式">
              <el-checkbox v-model="settings.notifyInapp">站内信</el-checkbox>
              <el-checkbox v-model="settings.notifyEmail">邮件通知</el-checkbox>
            </el-form-item>
            <el-button type="primary" @click="saveSettings">保存设置</el-button>
          </el-form>
        </el-card>

        <el-card shadow="never" style="margin-top: 12px">
          <template #header>修改密码</template>
          <el-form label-position="top">
            <el-form-item label="当前密码">
              <el-input v-model="passwordForm.currentPassword" type="password" show-password />
            </el-form-item>
            <el-form-item label="新密码">
              <el-input v-model="passwordForm.newPassword" type="password" show-password />
            </el-form-item>
            <el-button @click="changePassword">更新密码</el-button>
          </el-form>
        </el-card>

        <el-card shadow="never" style="margin-top: 12px">
          <template #header>注销账号</template>
          <p class="muted">
            注销后昵称会变为「已注销用户」，已发布的记录会匿名保留在地图上，历史贡献不会消失，但不再关联你的身份。
          </p>
          <el-button type="danger" plain @click="deleteAccount">注销账号</el-button>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
