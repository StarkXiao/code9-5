<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";
import type { FieldSuggestion } from "@/api/types";
import { useAuthStore } from "@/stores/auth";

/**
 * F11 评论细节字段建议卡片。
 * - 作者视角：展示该条目下全部状态的建议，pending 的可采纳/忽略；
 * - 其他访客：展示 accepted 建议（"哪些细节来自大家的补充"）。
 */
const props = defineProps<{ spotUuid: string; ownerUuid?: string | null }>();
const emit = defineEmits<{ (e: "accepted"): void }>();

const auth = useAuthStore();
const items = ref<FieldSuggestion[]>([]);
const loading = ref(false);
const busyId = ref<string | null>(null);

const isOwner = computed(
  () => Boolean(auth.user?.uuid) && Boolean(props.ownerUuid) && auth.user?.uuid === props.ownerUuid,
);

const pending = computed(() => items.value.filter((item) => item.status === "pending" && !item.expired));
const accepted = computed(() => items.value.filter((item) => item.status === "accepted"));
const closed = computed(() =>
  items.value.filter((item) => item.status === "dismissed" || item.status === "expired" || item.expired),
);

const STATUS_TEXT: Record<string, string> = {
  dismissed: "已忽略",
  expired: "已过期",
};

async function load() {
  loading.value = true;
  try {
    const result = await api.get<{ items: FieldSuggestion[] }>(`/spots/${props.spotUuid}/suggestions`);
    items.value = result.items;
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

async function accept(item: FieldSuggestion) {
  busyId.value = item.id;
  try {
    await api.post(`/suggestions/${item.id}/accept`);
    ElMessage.success(`已把「${item.fieldLabel}」补充到条目`);
    emit("accepted");
    await load();
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    busyId.value = null;
  }
}

async function dismiss(item: FieldSuggestion) {
  try {
    const { value } = await ElMessageBox.prompt("可以告诉补充的人为什么不采纳吗（可不填）", "忽略这条建议", {
      confirmButtonText: "忽略",
      cancelButtonText: "取消",
      inputPlaceholder: "选填",
      inputValidator: (text) => (text === null || text.trim().length <= 200) || "理由不超过 200 字",
    });
    busyId.value = item.id;
    await api.post(`/suggestions/${item.id}/dismiss`, { reason: value?.trim() || undefined });
    ElMessage.success("已忽略");
    await load();
  } catch (error) {
    // 用户取消时 error.message 为 "cancel"，不提示
    if (error instanceof Error && error.message !== "cancel") {
      ElMessage.error(error.message);
    }
  } finally {
    busyId.value = null;
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <div v-loading="loading">
    <!-- 作者：待确认 -->
    <template v-if="isOwner">
      <el-alert
        v-if="pending.length > 0"
        type="success"
        :closable="false"
        show-icon
        :title="'评论里有 ' + pending.length + ' 条细节建议等你确认'"
        style="margin-bottom: 12px"
      />

      <el-card
        v-for="item in pending"
        :key="item.id"
        shadow="never"
        class="suggestion-card suggestion-card--pending"
      >
        <div class="suggestion-row">
          <div class="suggestion-body">
            <p class="suggestion-title">
              <strong>{{ item.fieldLabel }}</strong>
              <el-tag size="small" type="success" effect="plain" style="margin-left: 8px">
                建议值：{{ item.valueLabel }}
              </el-tag>
            </p>
            <p v-for="(line, index) in item.evidence" :key="index" class="suggestion-evidence">
              “{{ line }}”
            </p>
            <p class="muted" style="margin: 4px 0 0">
              来自 {{ item.commenter?.nickname ?? "匿名" }} 的评论 ·
              {{ new Date(item.createdAt).toLocaleDateString("zh-CN") }}
            </p>
          </div>
          <div class="suggestion-actions">
            <el-button type="primary" size="small" :loading="busyId === item.id" @click="accept(item)">
              采纳并写入条目
            </el-button>
            <el-button size="small" :disabled="busyId === item.id" @click="dismiss(item)">忽略</el-button>
          </div>
        </div>
      </el-card>

      <div v-if="closed.length" class="suggestion-closed">
        <p v-for="item in closed" :key="item.id" class="muted" style="margin: 2px 0; font-size: 13px">
          {{ STATUS_TEXT[item.status] ?? item.status }}：{{ item.fieldLabel }}（{{ item.valueLabel }}）
          <template v-if="item.decideReason">——{{ item.decideReason }}</template>
        </p>
      </div>
    </template>

    <!-- 访客：仅展示已被采纳的补充来源 -->
    <template v-else>
      <div v-if="accepted.length" class="suggestion-accepted">
        <p class="muted" style="margin: 0 0 6px; font-size: 13px">以下细节由评论补充、发布者确认：</p>
        <el-tag
          v-for="item in accepted"
          :key="item.id"
          size="small"
          type="info"
          effect="plain"
          style="margin: 0 6px 6px 0"
        >
          {{ item.fieldLabel }}：{{ item.valueLabel }}
        </el-tag>
      </div>
    </template>
  </div>
</template>

<style scoped>
.suggestion-card {
  margin-bottom: 10px;
  border-left: 3px solid var(--el-color-success);
}

.suggestion-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.suggestion-body {
  flex: 1;
  min-width: 220px;
}

.suggestion-title {
  margin: 0 0 6px;
}

.suggestion-evidence {
  margin: 2px 0;
  padding-left: 8px;
  border-left: 2px solid var(--el-color-success-light-5);
  color: var(--color-text-soft, #666);
  font-size: 13px;
}

.suggestion-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-end;
}

.suggestion-closed {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--el-border-color-lighter);
}
</style>
