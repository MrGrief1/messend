import { AutoComplete, Option, Avatar, Field, FieldRow, FieldDescription, FieldError } from '@rocket.chat/fuselage';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { isFirstPeerAutocompleteOption } from '../MediaCallContext';

export type PeerAutocompleteOptions = {
	value: string; // user id
	label: string; // name or username
	identifier?: string | number; // extension number
	avatarUrl?: string;
};

type PeerAutocompleteProps = {
	options: PeerAutocompleteOptions[];
	onChangeValue: (value: string | string[]) => void;
	onChangeFilter: (filter: string) => void;
	filter: string;
	value: string | undefined;
	error?: string;
};

const PeerAutocomplete = ({ options, filter, value, onChangeValue, onChangeFilter, error }: PeerAutocompleteProps) => {
	const { t } = useTranslation();

	const fieldDescriptionId = useId();
	const fieldErrorId = useId();

	return (
		<Field mb={-2}>
			<FieldRow>
				<AutoComplete
					aria-labelledby={fieldDescriptionId}
					aria-describedby={error ? fieldErrorId : undefined}
					aria-invalid={!!error}
					error={!!error}
					setFilter={onChangeFilter}
					filter={filter}
					onChange={onChangeValue}
					options={options}
					value={value}
					renderItem={({ value, label, ...props }) => {
						if (isFirstPeerAutocompleteOption(value)) {
							return <Option key={value} label={label} icon='phone-out' {...props} />;
						}
						const thisOption = options.find((option) => option.value === value);
						return <Option key={value} label={label} avatar={<Avatar size='x20' url={thisOption?.avatarUrl || ''} />} {...props} />;
					}}
					renderSelected={() => null}
				/>
			</FieldRow>
			{error && <FieldError id={fieldErrorId}>{error}</FieldError>}
			<FieldDescription id={fieldDescriptionId}>{t('Enter_username_or_number')}</FieldDescription>
		</Field>
	);
};

export default PeerAutocomplete;
