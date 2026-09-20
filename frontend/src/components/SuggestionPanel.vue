<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";
import type { Category, DetailSuggestion } from "@/api/types";

// 条目详情页上"评论里的新细节，等你确认"卡片。
// 只有条目作者能看到这个组件（后端也会再鉴权一次）。
const props = defineProps<{
  spotUuid: string;
  category: Category;
  isOwner: boolean;
}>();

const emit = defineEmits<{ (e: "accepted"): void }>();

const items = ref<DetailSuggestion[]>([]);
const loading = ref(false);
const busyId = ref<string | null>(null);

const pending = computed(() => items.value.filter((item) => item.status === "pending"));

// 把建议值翻译成给作者看的人话：布尔→是/否，枚举→枚举标签
function describeValue(item: DetailSuggestion): string {
  const property = props.category.schema.properties[item.fieldKey];

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

async function load() {
  if (!props.isOwner) return;
  loading.value = true;
  try {
    const result = await api.get<{ items: DetailSuggestion[] }>(
      `/spots/${props.spotUuid}/suggestions`,
    );
    items.value = result.items;
  } catch {
    // 非作者会被后端 403，静默即可；其他错误不打扰详情页浏览
    items.value = [];
  } finally {
    loading.value = false;
  }
}

async function accept(item: DetailSuggestion) {
  busyId.value = item.id;
  try {
    await api.post(`/suggestions/${item.id}/accept`);
    ElMessage.success(`已把「${item.fieldLabel}」补充到条目`);
    item.status = "accepted";
    emit("accepted");
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    busyId.value = null;
  }
}

async function reject(item: DetailSuggestion) {
  try {
    const { value } = await ElMessageBox.prompt(
      "可以告诉对方为什么没采纳（选填，会通知评论作者）",
      "不采纳这条补充",
      {
        confirmButtonText: "确认",
        cancelButtonText: "取消",
        inputPlaceholder: "例如：现场核实后情况不符",
        inputValidator: (text) => !text || text.trim().length <= 200 || "理由不超过 200 字",
      },
    );
    busyId.value = item.id;
    await api.post(`/suggestions/${item.id}/reject`, { reason: value?.trim() || undefined });
    item.status = "rejected";
    ElMessage.success("已忽略这条补充");
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  } finally {
    busyId.value = null;
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <section v-if="isOwner && pending.length > 0" v-loading="loading" class="card suggestions-card">
    <h3 style="margin: 0 0 4px; font-size: 16px">评论里有人补充了细节，等你确认</h3>
    <p class="muted" style="margin: 0 0 12px">
      采纳后会直接写进这条记录；30 天内没有处理的建议会自动失效。
    </p>

    <div v-for="item in pending" :key="item.id" class="suggestion-item">
      <div class="suggestion-body">
        <p style="margin: 0">
          <strong>{{ item.fieldLabel }}</strong>
          <el-tag size="small" type="success" effect="plain" style="margin-left: 8px">
            建议填：{{ describeValue(item) }}
          </el-tag>
          <el-tag v-if="item.supportCount > 1" size="small" type="info" effect="plain" style="margin-left: 6px">
            {{ item.supportCount }} 人提到
          </el-tag>
        </p>
        <p class="suggestion-evidence">
          「{{ item.evidence }}」
          <span class="muted">—— {{ item.sourceUser?.nickname ?? "匿名用户" }} 的评论</span>
        </p>
      </div>
      <div class="suggestion-actions">
        <el-button type="primary" size="small" :loading="busyId === item.id" @click="accept(item)">
          采纳并补充
        </el-button>
        <el-button size="small" :disabled="busyId === item.id" @click="reject(item)">不采纳</el-button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.suggestions-card {
  border-color: var(--el-color-primary-light-5);
}

.suggestion-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--el-border-color-lighter);
}

.suggestion-item:first-of-type {
  border-top: none;
}

.suggestion-evidence {
  margin: 6px 0 0;
  color: var(--color-text-soft);
  font-size: 13px;
  line-height: 1.6;
}

.suggestion-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

@media (max-width: 640px) {
  .suggestion-item {
    flex-direction: column;
  }
}
</style>
