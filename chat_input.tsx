import {
  Button, Divider, EmptyView, HStack, Image, Menu, ScrollView, Spacer, Text, TextField, VStack, ZStack,
} from "scripting"

export interface ChatModelOption {
  id: string
  label: string
  active: boolean
}

/**
 * 已选图片的缩略图行：在输入框上方横排展示，删除按钮覆盖在右上角。
 * 点缩略图走 QuickLook 预览。
 */
export function PendingImagesRow({
  images, onRemove,
}: {
  images: string[]
  onRemove: (path: string) => void
}) {
  // Scripting 的 FunctionComponent 不能返回 null，否则清空数组时原生视图重建失败，
  // 屏幕上会残留上一次的缩略图。
  if (!images || images.length === 0) return <EmptyView />
  return (
    <ScrollView axes="horizontal">
      <HStack spacing={10} padding={{ horizontal: 12, top: 10, bottom: 4 }}>
        {images.map((p) => (
          <ZStack key={p} alignment="topTrailing">
            <Image
              filePath={p}
              resizable
              frame={{ width: 72, height: 72 }}
              clipShape={{ type: "rect", cornerRadius: 8 }}
              onTapGesture={() => {
                QuickLook.previewURLs([p]).catch(() => {})
              }}
            />
            <Button action={() => onRemove(p)}>
              <Image
                systemName="xmark.circle.fill"
                font="title3"
                foregroundStyle="label"
                background="systemBackground"
                clipShape="circle"
                offset={{ x: 5, y: -5 }}
              />
            </Button>
          </ZStack>
        ))}
      </HStack>
    </ScrollView>
  )
}

/**
 * iOS 风格底部输入器：图片草稿、模型 / 能力工具条、输入框与发送按钮。
 * 纯展示——状态与事件全由父级传入。
 */
export function ChatInputBar({
  input, onInput, onSend, sendEnabled, busy, hasMounts, onOpenMounts,
  imageEnabled, onPickImages,
  images, onRemoveImage,
  models, modelLabel, onSelectModel, onManageModels,
}: {
  input: string
  onInput: (v: string) => void
  onSend: () => void
  sendEnabled: boolean
  busy: boolean
  hasMounts: boolean
  onOpenMounts: () => void
  /** 是否显示图片按钮（配置里 imageEnabled 打开才显示）。 */
  imageEnabled: boolean
  /** 点图片按钮时触发（由父级去调 Photos.pick 并落盘）。 */
  onPickImages: () => void
  /** 已选图片（落盘后的路径），用于在输入框上方画缩略图。 */
  images: string[]
  /** 删除某张已选图片。 */
  onRemoveImage: (path: string) => void
  models: ChatModelOption[]
  modelLabel: string
  onSelectModel: (id: string) => void
  onManageModels: () => void
}) {
  return (
    <VStack
      spacing={0}
      frame={{ maxWidth: "infinity" }}
      background="secondarySystemBackground"
    >
      <Divider />
      <PendingImagesRow images={images} onRemove={onRemoveImage} />
      <HStack spacing={12} padding={{ horizontal: 14, top: 8 }}>
        <Menu
          label={
            <HStack spacing={5}>
              <Image systemName="cpu" font="caption" foregroundStyle="secondaryLabel" />
              <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>
                {modelLabel}
              </Text>
              <Image systemName="chevron.down" font="caption2" foregroundStyle="tertiaryLabel" />
            </HStack>
          }
        >
          {models.map((model) =>
            model.active ? (
              <Button
                key={model.id}
                title={model.label}
                systemImage="checkmark"
                action={() => onSelectModel(model.id)}
              />
            ) : (
              <Button key={model.id} title={model.label} action={() => onSelectModel(model.id)} />
            ),
          )}
          <Button title="管理模型" systemImage="gearshape" action={onManageModels} />
        </Menu>
        <Spacer />
        <Button action={onOpenMounts} disabled={busy}>
          <Image
            systemName="slider.horizontal.3"
            font="body"
            foregroundStyle={hasMounts ? "systemBlue" : "secondaryLabel"}
          />
        </Button>
      </HStack>
      <HStack spacing={10} padding={{ horizontal: 12, top: 8, bottom: 10 }}>
        {imageEnabled ? (
          <Button action={onPickImages} disabled={busy}>
            <Image
              systemName="plus"
              font="title3"
              foregroundStyle={images.length > 0 ? "systemBlue" : "secondaryLabel"}
              frame={{ width: 32, height: 32 }}
              background="tertiarySystemFill"
              clipShape="circle"
            />
          </Button>
        ) : null}
        <HStack
          padding={{ horizontal: 14, vertical: 10 }}
          background="systemBackground"
          clipShape={{ type: "rect", cornerRadius: 8 }}
          frame={{ maxWidth: "infinity" }}
        >
          <TextField
            title=""
            prompt="说点什么…"
            value={input}
            onChanged={onInput}
            submitLabel="send"
            onSubmit={onSend}
          />
        </HStack>
        <Button action={onSend} disabled={!sendEnabled}>
          <Image
            systemName="arrow.up"
            font="headline"
            foregroundStyle={sendEnabled ? "white" : "tertiaryLabel"}
            frame={{ width: 34, height: 34 }}
            background={sendEnabled ? "systemBlue" : "tertiarySystemFill"}
            clipShape="circle"
          />
        </Button>
      </HStack>
    </VStack>
  )
}
