jest.mock('@expo/config-plugins', () => ({
    withAndroidManifest: config => config,
    withMainActivity: (config, action) => action(config),
}));

const withAndroidShare = require('../plugins/withAndroidShare');

const applySharePlugin = async contents => {
    const config = await withAndroidShare({ modResults: { contents } });
    return config.modResults.contents;
};

const activity = String.raw`
import android.os.Bundle
class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
    handleShareIntent(intent) // Injected
  }
  override fun createReactActivityDelegate() =
    object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled){}
}
`;

it('冷启动改用初始属性时，移除旧的重复分享事件并保留热启动事件', async () => {
    const result = await applySharePlugin(activity);
    expect(result).toContain('initialProps.putString("sharedText", sharedText)');
    expect(result).not.toContain('handleShareIntent(intent) // Injected');
    expect(result).toContain('override fun onNewIntent(intent: Intent)');
    expect(await applySharePlugin(result)).toBe(result);
});

it('找不到初始属性入口时，仍通过 onCreate 事件交付一次', async () => {
    const source = activity
        .replace('handleShareIntent(intent) // Injected', '')
        .replace('object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled){}', 'customDelegate()');
    const result = await applySharePlugin(source);
    expect(result).not.toContain('initialProps.putString("sharedText", sharedText)');
    expect(result.match(/handleShareIntent\(intent\) \/\/ Injected/g)).toHaveLength(1);
    expect(await applySharePlugin(result)).toBe(result);
});
